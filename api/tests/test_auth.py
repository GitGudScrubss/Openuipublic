"""
Unit tests for AuthMiddleware.

Uses unittest.mock to stub Redis and Supabase HTTP calls — no live
infrastructure required.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.responses import JSONResponse

from api.middleware.auth import AuthMiddleware


# ---------------------------------------------------------------------------
# Minimal app fixture
# ---------------------------------------------------------------------------

def _make_app(redis_mock) -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuthMiddleware, redis_client=redis_mock)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/protected")
    async def protected(request: Request):
        return {"user_id": request.state.user_id, "tier": request.state.tier}

    return app


def _redis_mock(cached_value=None):
    r = AsyncMock()
    r.get = AsyncMock(return_value=cached_value)
    r.setex = AsyncMock()
    return r


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAuthSkip:
    def test_health_skips_auth(self):
        client = TestClient(_make_app(_redis_mock()))
        resp = client.get("/health")
        assert resp.status_code == 200

    def test_options_skips_auth(self):
        # Auth middleware skips OPTIONS — no 401. Router may 405 without CORS
        # middleware, but the important thing is auth didn't reject the request.
        client = TestClient(_make_app(_redis_mock()))
        resp = client.options("/protected")
        assert resp.status_code != 401


class TestMissingToken:
    def test_no_header_returns_401(self):
        client = TestClient(_make_app(_redis_mock()))
        resp = client.get("/protected")
        assert resp.status_code == 401
        assert resp.json()["reason"] == "missing_token"

    def test_wrong_scheme_returns_401(self):
        client = TestClient(_make_app(_redis_mock()))
        resp = client.get("/protected", headers={"Authorization": "Basic abc123"})
        assert resp.status_code == 401


class TestCacheHit:
    def test_valid_cached_token_passes(self):
        cached = json.dumps({"user_id": "u1", "tier": "pro"})
        client = TestClient(_make_app(_redis_mock(cached_value=cached)))
        resp = client.get("/protected", headers={"Authorization": "Bearer validtoken"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["user_id"] == "u1"
        assert body["tier"] == "pro"


class TestSupabaseCall:
    def _supabase_response(self, status: int, body: dict):
        mock_resp = MagicMock()
        mock_resp.status_code = status
        mock_resp.json.return_value = body
        return mock_resp

    @patch("api.middleware.auth.httpx.AsyncClient")
    def test_valid_token_fetches_supabase(self, mock_client_cls):
        supabase_body = {
            "id": "user-abc",
            "app_metadata": {"tier": "pro"},
            "user_metadata": {},
        }
        mock_resp = self._supabase_response(200, supabase_body)
        mock_client_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(get=AsyncMock(return_value=mock_resp))
        )
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        redis = _redis_mock(cached_value=None)
        client = TestClient(_make_app(redis))
        resp = client.get("/protected", headers={"Authorization": "Bearer tok"})
        assert resp.status_code == 200
        assert resp.json()["tier"] == "pro"
        redis.setex.assert_awaited_once()

    @patch("api.middleware.auth.httpx.AsyncClient")
    def test_expired_token_returns_401(self, mock_client_cls):
        mock_resp = self._supabase_response(401, {"message": "invalid JWT"})
        mock_client_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(get=AsyncMock(return_value=mock_resp))
        )
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        client = TestClient(_make_app(_redis_mock()))
        resp = client.get("/protected", headers={"Authorization": "Bearer expired"})
        assert resp.status_code == 401
        assert resp.json()["reason"] == "invalid_or_expired"

    @patch("api.middleware.auth.httpx.AsyncClient")
    def test_unknown_tier_defaults_to_free(self, mock_client_cls):
        supabase_body = {"id": "u2", "app_metadata": {"tier": "vip"}, "user_metadata": {}}
        mock_resp = self._supabase_response(200, supabase_body)
        mock_client_cls.return_value.__aenter__ = AsyncMock(
            return_value=MagicMock(get=AsyncMock(return_value=mock_resp))
        )
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

        client = TestClient(_make_app(_redis_mock()))
        resp = client.get("/protected", headers={"Authorization": "Bearer tok"})
        assert resp.status_code == 200
        assert resp.json()["tier"] == "free"
