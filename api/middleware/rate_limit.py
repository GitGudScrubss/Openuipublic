"""
RateLimitMiddleware — per-tier daily sliding-window rate limiter backed by Redis.

Limits (requests per 24-hour rolling window):
  free:       20 chat / 20 voice
  pro:        500 chat / 200 voice
  enterprise: unlimited

Returns HTTP 429 with JSON body on breach:
  { error, tier, remaining, limit, reset_at }

Uses a Lua script for an atomic check-then-increment so no double-spend
or over-count can occur under concurrent load.
"""

import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TIER_LIMITS: dict[str, dict[str, Optional[int]]] = {
    "free":       {"chat": 20,  "voice": 20},
    "pro":        {"chat": 500, "voice": 200},
    "enterprise": {"chat": None, "voice": None},  # None = unlimited
}

_WINDOW_SECONDS = 86_400  # 24-hour rolling window
_WINDOW_TTL = _WINDOW_SECONDS + 120  # Redis key expiry with a small buffer

_CHAT_RE = re.compile(r"^/(v\d+/)?chat(/|$)")
_VOICE_RE = re.compile(r"^/(v\d+/)?voice(/|$)")

# ---------------------------------------------------------------------------
# Lua script — atomic sliding-window check + increment
#
# Returns: [current_count (after attempt), allowed (1|0)]
# ---------------------------------------------------------------------------

_SLIDING_WINDOW_LUA = """
local key          = KEYS[1]
local now          = tonumber(ARGV[1])
local window_start = tonumber(ARGV[2])
local limit        = tonumber(ARGV[3])
local member       = ARGV[4]
local ttl          = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
local count = tonumber(redis.call('ZCARD', key))

if count < limit then
    redis.call('ZADD', key, now, member)
    redis.call('EXPIRE', key, ttl)
    return {count + 1, 1}
end
return {count, 0}
"""


def _next_midnight_utc() -> str:
    now = datetime.now(timezone.utc)
    midnight = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return midnight.isoformat()


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, redis_client) -> None:
        super().__init__(app)
        self._redis = redis_client
        self._script = redis_client.register_script(_SLIDING_WINDOW_LUA)

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        path = request.url.path

        if _CHAT_RE.match(path):
            request_type = "chat"
        elif _VOICE_RE.match(path):
            request_type = "voice"
        else:
            return await call_next(request)

        user_id: Optional[str] = getattr(request.state, "user_id", None)
        tier: str = getattr(request.state, "tier", "free")

        # Auth middleware should have rejected unauthenticated requests already,
        # but guard here defensively.
        if user_id is None:
            return await call_next(request)

        limit = TIER_LIMITS.get(tier, TIER_LIMITS["free"])[request_type]
        if limit is None:
            return await call_next(request)  # enterprise — unlimited

        now_ms = int(time.time() * 1000)
        window_start_ms = now_ms - _WINDOW_SECONDS * 1000
        redis_key = f"rate:{user_id}:{request_type}"

        count, allowed = await self._script(
            keys=[redis_key],
            args=[now_ms, window_start_ms, limit, str(uuid.uuid4()), _WINDOW_TTL],
        )
        count = int(count)
        allowed = int(allowed)

        if not allowed:
            remaining = max(0, limit - count)
            return JSONResponse(
                {
                    "error": "rate_limited",
                    "tier": tier,
                    "remaining": remaining,
                    "limit": limit,
                    "reset_at": _next_midnight_utc(),
                },
                status_code=429,
            )

        return await call_next(request)
