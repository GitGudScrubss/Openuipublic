"""
Unit tests for RateLimitMiddleware.

Stubs the Redis Lua script so tests run without a live Redis instance.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from api.middleware.rate_limit import RateLimitMiddleware, TIER_LIMITS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _redis_mock(lua_return: list):
    """
    lua_return: [count, allowed]  e.g. [1, 1] = first request allowed,
                                       [20, 0] = limit hit.
    """
    script_mock = AsyncMock(return_value=lua_return)
    redis = MagicMock()
    redis.register_script = MagicMock(return_value=script_mock)
    return redis, script_mock


def _make_app(redis_mock, user_id="u1", tier="free") -> FastAPI:
    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, redis_client=redis_mock)

    async def _set_state(request: Request, call_next):
        request.state.user_id = user_id
        request.state.tier = tier
        return await call_next(request)

    app.middleware("http")(_set_state)

    @app.post("/chat")
    async def chat(request: Request):
        return {"ok": True}

    @app.post("/voice")
    async def voice(request: Request):
        return {"ok": True}

    @app.get("/other")
    async def other():
        return {"ok": True}

    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestAllowed:
    def test_chat_request_within_limit(self):
        redis, _ = _redis_mock([1, 1])
        client = TestClient(_make_app(redis))
        resp = client.post("/chat")
        assert resp.status_code == 200

    def test_voice_request_within_limit(self):
        redis, _ = _redis_mock([1, 1])
        client = TestClient(_make_app(redis))
        resp = client.post("/voice")
        assert resp.status_code == 200

    def test_non_rate_limited_path_always_passes(self):
        redis, script = _redis_mock([999, 0])
        client = TestClient(_make_app(redis))
        resp = client.get("/other")
        assert resp.status_code == 200
        script.assert_not_awaited()


class TestRateLimited:
    def test_429_on_limit_exceeded(self):
        redis, _ = _redis_mock([20, 0])
        client = TestClient(_make_app(redis, tier="free"))
        resp = client.post("/chat")
        assert resp.status_code == 429
        body = resp.json()
        assert body["error"] == "rate_limited"
        assert body["tier"] == "free"
        assert body["remaining"] == 0
        assert body["limit"] == TIER_LIMITS["free"]["chat"]
        assert "reset_at" in body

    def test_429_body_includes_reset_at_iso(self):
        redis, _ = _redis_mock([500, 0])
        client = TestClient(_make_app(redis, tier="pro"))
        resp = client.post("/chat")
        assert resp.status_code == 429
        # reset_at must be parseable ISO 8601
        from datetime import datetime
        datetime.fromisoformat(resp.json()["reset_at"])

    def test_correct_limit_in_body_for_voice(self):
        redis, _ = _redis_mock([20, 0])
        client = TestClient(_make_app(redis, tier="free"))
        resp = client.post("/voice")
        assert resp.status_code == 429
        assert resp.json()["limit"] == TIER_LIMITS["free"]["voice"]


class TestEnterprise:
    def test_enterprise_skips_rate_check(self):
        redis, script = _redis_mock([9999, 0])
        client = TestClient(_make_app(redis, tier="enterprise"))
        resp = client.post("/chat")
        assert resp.status_code == 200
        script.assert_not_awaited()


class TestLuaKeyArgs:
    def test_lua_called_with_correct_key(self):
        redis, script = _redis_mock([1, 1])
        client = TestClient(_make_app(redis, user_id="alice", tier="free"))
        client.post("/chat")
        call_kwargs = script.call_args
        assert call_kwargs.kwargs["keys"] == ["rate:alice:chat"]

    def test_lua_called_with_limit_arg(self):
        redis, script = _redis_mock([1, 1])
        client = TestClient(_make_app(redis, tier="pro"))
        client.post("/voice")
        args = script.call_args.kwargs["args"]
        # args[2] is the limit
        assert int(args[2]) == TIER_LIMITS["pro"]["voice"]
