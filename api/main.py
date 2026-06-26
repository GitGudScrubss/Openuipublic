"""
OpenUI API — FastAPI application entry point.

Middleware order (outermost → innermost, i.e. request execution order):
  1. AuthMiddleware     — validates JWT, sets request.state.{user_id, tier}
  2. RateLimitMiddleware — enforces per-tier daily sliding-window limits

add_middleware() wraps in LIFO order, so Auth must be added LAST.
"""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.dependencies import close_redis, init_redis
from api.middleware.auth import AuthMiddleware
from api.middleware.rate_limit import RateLimitMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    redis = await init_redis()
    logger.info("Redis connected: %s", os.environ.get("REDIS_URL", "redis://localhost:6379/0"))

    # Attach middleware here so both share the same redis instance
    app.add_middleware(RateLimitMiddleware, redis_client=redis)
    app.add_middleware(AuthMiddleware, redis_client=redis)

    yield

    await close_redis()
    logger.info("Redis connection closed")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="OpenUI API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    """Unauthenticated liveness probe — skipped by auth middleware."""
    return {"status": "ok"}


@app.post("/chat")
async def chat(request: Request):
    """Stub chat endpoint — replace with real handler."""
    return {
        "user_id": request.state.user_id,
        "tier": request.state.tier,
        "message": "chat handler not yet implemented",
    }


@app.post("/voice")
async def voice(request: Request):
    """Stub voice endpoint — replace with real handler."""
    return {
        "user_id": request.state.user_id,
        "tier": request.state.tier,
        "message": "voice handler not yet implemented",
    }


# ---------------------------------------------------------------------------
# Global exception handler (catches unexpected errors before they leak)
# ---------------------------------------------------------------------------

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("unhandled_error path=%s", request.url.path)
    return JSONResponse({"error": "internal_server_error"}, status_code=500)
