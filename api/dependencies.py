"""
Shared application dependencies — Redis client singleton.
"""

import os
from typing import Optional

import redis.asyncio as aioredis

_redis_client: Optional[aioredis.Redis] = None


async def init_redis() -> aioredis.Redis:
    """Create the module-level Redis client; call once at startup."""
    global _redis_client
    url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    _redis_client = aioredis.from_url(url, decode_responses=True)
    await _redis_client.ping()
    return _redis_client


async def close_redis() -> None:
    global _redis_client
    if _redis_client is not None:
        await _redis_client.aclose()
        _redis_client = None


def get_redis() -> aioredis.Redis:
    if _redis_client is None:
        raise RuntimeError("Redis client not initialised — call init_redis() at startup")
    return _redis_client
