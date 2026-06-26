"""
AuthMiddleware — validates every request's JWT against Supabase,
caches the result in Redis for 5 minutes, and attaches user_id + tier
to request.state.

Skipped for: GET /health, OPTIONS (CORS preflight).
"""

import hashlib
import json
import logging
import os
from typing import Optional

import httpx
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger(__name__)

_SKIP_PATHS = frozenset({"/health"})
_CACHE_TTL = 300  # seconds — 5 minutes
_VALID_TIERS = frozenset({"free", "pro", "enterprise"})


class AuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, redis_client) -> None:
        super().__init__(app)
        self._redis = redis_client
        self._supabase_url = os.environ["SUPABASE_URL"].rstrip("/")

    # ------------------------------------------------------------------
    # Main dispatch
    # ------------------------------------------------------------------

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if request.method == "OPTIONS" or request.url.path in _SKIP_PATHS:
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            logger.warning(
                "auth_failure reason=missing path=%s method=%s",
                request.url.path,
                request.method,
            )
            return JSONResponse(
                {"error": "unauthorized", "reason": "missing_token"},
                status_code=401,
            )

        token = auth_header[len("Bearer "):]
        user_info = await self._validate_token(token)
        if user_info is None:
            # Reason already logged inside _validate_token
            return JSONResponse(
                {"error": "unauthorized", "reason": "invalid_or_expired"},
                status_code=401,
            )

        request.state.user_id = user_info["user_id"]
        request.state.tier = user_info["tier"]
        return await call_next(request)

    # ------------------------------------------------------------------
    # Token validation (cache-first, then Supabase)
    # ------------------------------------------------------------------

    async def _validate_token(self, token: str) -> Optional[dict]:
        cache_key = f"auth:{hashlib.sha256(token.encode()).hexdigest()}"

        cached = await self._redis.get(cache_key)
        if cached:
            return json.loads(cached)

        user_info = await self._fetch_supabase_user(token)
        if user_info is not None:
            await self._redis.setex(cache_key, _CACHE_TTL, json.dumps(user_info))
        return user_info

    async def _fetch_supabase_user(self, token: str) -> Optional[dict]:
        url = f"{self._supabase_url}/auth/v1/user"
        headers = {
            "Authorization": f"Bearer {token}",
            "apikey": os.environ.get("SUPABASE_ANON_KEY", ""),
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(url, headers=headers)
        except httpx.RequestError as exc:
            logger.error("supabase_request_error: %s", exc)
            return None

        if resp.status_code == 401:
            logger.warning("auth_failure reason=expired status=401")
            return None
        if resp.status_code != 200:
            logger.warning("auth_failure reason=invalid status=%d", resp.status_code)
            return None

        data = resp.json()
        user_id: Optional[str] = data.get("id")
        if not user_id:
            logger.warning("auth_failure reason=missing_user_id")
            return None

        # Tier lives in app_metadata (server-controlled) with user_metadata as fallback
        app_meta: dict = data.get("app_metadata") or {}
        user_meta: dict = data.get("user_metadata") or {}
        tier: str = app_meta.get("tier") or user_meta.get("tier") or "free"
        if tier not in _VALID_TIERS:
            tier = "free"

        return {"user_id": user_id, "tier": tier}
