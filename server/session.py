"""
SessionManager — per-user conversation context backed by Redis (hot) and Postgres (durable).

Redis layout
------------
  session:{user_id}:{conv_id}:history  — list of JSON-serialised Message objects (capped at 20)
  session:{user_id}:active_task        — JSON TaskState for the running task, if any
  session:{user_id}:prefs              — JSON user-preference dict

All Redis keys carry a 24-hour TTL that is refreshed on every write.
Postgres writes are fire-and-forget (asyncio.ensure_future) so they never block a response.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import asyncpg
import redis.asyncio as aioredis

from core.memory import Message

logger = logging.getLogger(__name__)

SESSION_TTL: int = 86_400   # 24 hours in seconds
MAX_HISTORY: int = 20       # sliding window kept in Redis


# ---------------------------------------------------------------------------
# Domain types
# ---------------------------------------------------------------------------

@dataclass
class TaskState:
    """Active task state stored per user (one slot per user, not per conversation)."""
    task_id: str
    goal: str
    status: str                                     # pending | in_progress | completed | failed
    steps: List[Dict[str, Any]] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "goal": self.goal,
            "status": self.status,
            "steps": self.steps,
            "started_at": self.started_at,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TaskState":
        return cls(
            task_id=data["task_id"],
            goal=data["goal"],
            status=data["status"],
            steps=data.get("steps", []),
            started_at=data.get("started_at", time.time()),
            metadata=data.get("metadata", {}),
        )


# ---------------------------------------------------------------------------
# SessionManager
# ---------------------------------------------------------------------------

class SessionManager:
    """
    Manages per-user conversation context.

    Fast path  — Redis  : message history, active task state, user preferences.
    Durable path — Postgres : full message log, conversation metadata, usage counters.

    Usage
    -----
    sm = SessionManager(redis_url="redis://localhost:6379", postgres_dsn="postgresql://...")
    await sm.connect()
    ...
    await sm.close()
    """

    def __init__(self, redis_url: str, postgres_dsn: str) -> None:
        self._redis_url = redis_url
        self._postgres_dsn = postgres_dsn
        self._redis: Optional[aioredis.Redis] = None
        self._pg: Optional[asyncpg.Pool] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Open Redis connection and Postgres pool, then ensure schema exists."""
        self._redis = await aioredis.from_url(self._redis_url, decode_responses=True)
        self._pg = await asyncpg.create_pool(self._postgres_dsn, min_size=2, max_size=10)
        await self._ensure_schema()

    async def close(self) -> None:
        """Gracefully close all connections."""
        if self._redis:
            await self._redis.aclose()
        if self._pg:
            await self._pg.close()

    # ------------------------------------------------------------------
    # Key helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _history_key(user_id: str, conv_id: str) -> str:
        return f"session:{user_id}:{conv_id}:history"

    @staticmethod
    def _task_key(user_id: str) -> str:
        return f"session:{user_id}:active_task"

    @staticmethod
    def _prefs_key(user_id: str) -> str:
        return f"session:{user_id}:prefs"

    # ------------------------------------------------------------------
    # Message history (Redis)
    # ------------------------------------------------------------------

    async def get_history(self, user_id: str, conv_id: str) -> List[Message]:
        """Return up to the last 20 messages for this conversation from Redis."""
        assert self._redis, "SessionManager.connect() not called"
        key = self._history_key(user_id, conv_id)
        raw_list = await self._redis.lrange(key, 0, -1)
        messages: List[Message] = []
        for raw in raw_list:
            try:
                data = json.loads(raw)
                messages.append(Message(
                    role=data["role"],
                    content=data.get("content", ""),
                    tool_call_id=data.get("tool_call_id"),
                    tool_calls=data.get("tool_calls"),
                    name=data.get("name"),
                    timestamp=data.get("timestamp", time.time()),
                ))
            except (json.JSONDecodeError, KeyError):
                logger.warning("Skipping malformed message in session %s/%s", user_id, conv_id)
        return messages

    async def append_message(self, user_id: str, conv_id: str, message: Message) -> None:
        """
        Append a message, keep the newest MAX_HISTORY entries, refresh TTL.
        Postgres write is non-blocking (fire-and-forget).
        """
        assert self._redis, "SessionManager.connect() not called"
        key = self._history_key(user_id, conv_id)
        payload = json.dumps({
            "role": message.role,
            "content": message.content,
            "tool_call_id": message.tool_call_id,
            "tool_calls": message.tool_calls,
            "name": message.name,
            "timestamp": message.timestamp,
        })
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.rpush(key, payload)
            pipe.ltrim(key, -MAX_HISTORY, -1)
            pipe.expire(key, SESSION_TTL)
            await pipe.execute()

        asyncio.ensure_future(self._pg_persist_message(user_id, conv_id, message))

    async def clear_history(self, user_id: str, conv_id: str) -> None:
        """Delete the conversation history from Redis (Postgres records are retained)."""
        assert self._redis, "SessionManager.connect() not called"
        await self._redis.delete(self._history_key(user_id, conv_id))

    # ------------------------------------------------------------------
    # Active task (Redis)
    # ------------------------------------------------------------------

    async def get_active_task(self, user_id: str) -> Optional[TaskState]:
        """Return the currently active task for *user_id*, or None."""
        assert self._redis, "SessionManager.connect() not called"
        raw = await self._redis.get(self._task_key(user_id))
        if not raw:
            return None
        try:
            return TaskState.from_dict(json.loads(raw))
        except (json.JSONDecodeError, KeyError):
            logger.warning("Malformed task state for user %s — discarding", user_id)
            return None

    async def set_active_task(self, user_id: str, task: TaskState) -> None:
        """Persist the active task state for *user_id* with SESSION_TTL."""
        assert self._redis, "SessionManager.connect() not called"
        await self._redis.set(
            self._task_key(user_id),
            json.dumps(task.to_dict()),
            ex=SESSION_TTL,
        )

    async def clear_active_task(self, user_id: str) -> None:
        """Remove the active task entry for *user_id*."""
        assert self._redis, "SessionManager.connect() not called"
        await self._redis.delete(self._task_key(user_id))

    # ------------------------------------------------------------------
    # User preferences (Redis)
    # ------------------------------------------------------------------

    async def get_preferences(self, user_id: str) -> Dict[str, Any]:
        """Return stored user preferences dict (empty dict if none set)."""
        assert self._redis, "SessionManager.connect() not called"
        raw = await self._redis.get(self._prefs_key(user_id))
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    async def set_preferences(self, user_id: str, prefs: Dict[str, Any]) -> None:
        """Overwrite user preferences and refresh TTL."""
        assert self._redis, "SessionManager.connect() not called"
        await self._redis.set(
            self._prefs_key(user_id),
            json.dumps(prefs),
            ex=SESSION_TTL,
        )

    # ------------------------------------------------------------------
    # Postgres schema bootstrap
    # ------------------------------------------------------------------

    async def _ensure_schema(self) -> None:
        """Create tables and indexes if they do not already exist."""
        ddl_statements = [
            """
            CREATE TABLE IF NOT EXISTS conversations (
                id          TEXT        PRIMARY KEY,
                user_id     TEXT        NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, created_at)",
            """
            CREATE TABLE IF NOT EXISTS messages (
                id              BIGSERIAL   PRIMARY KEY,
                conversation_id TEXT        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role            TEXT        NOT NULL,
                content         TEXT        NOT NULL,
                tool_calls      JSONB,
                created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at)",
            """
            CREATE TABLE IF NOT EXISTS usage_tracking (
                user_id     TEXT NOT NULL,
                date        DATE NOT NULL DEFAULT CURRENT_DATE,
                chat_count  INT  NOT NULL DEFAULT 0,
                voice_count INT  NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, date)
            )
            """,
        ]
        async with self._pg.acquire() as conn:
            for stmt in ddl_statements:
                await conn.execute(stmt)

    # ------------------------------------------------------------------
    # Postgres fire-and-forget helpers
    # ------------------------------------------------------------------

    async def _pg_persist_message(self, user_id: str, conv_id: str, message: Message) -> None:
        """
        Upsert the parent conversation row then insert the message.
        Errors are logged but never propagated — callers must not await this.
        """
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO conversations (id, user_id)
                    VALUES ($1, $2)
                    ON CONFLICT (id) DO NOTHING
                    """,
                    conv_id,
                    user_id,
                )
                await conn.execute(
                    """
                    INSERT INTO messages (conversation_id, role, content, tool_calls)
                    VALUES ($1, $2, $3, $4)
                    """,
                    conv_id,
                    message.role,
                    message.content,
                    json.dumps(message.tool_calls) if message.tool_calls else None,
                )
        except Exception:
            logger.exception(
                "Failed to persist message to Postgres [user=%s conv=%s role=%s]",
                user_id, conv_id, message.role,
            )

    async def increment_usage(self, user_id: str, *, chat: int = 0, voice: int = 0) -> None:
        """
        Increment daily usage counters. Upserts the row for today.
        Also fire-and-forget safe to call without awaiting.
        """
        try:
            async with self._pg.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO usage_tracking (user_id, date, chat_count, voice_count)
                    VALUES ($1, CURRENT_DATE, $2, $3)
                    ON CONFLICT (user_id, date)
                    DO UPDATE SET
                        chat_count  = usage_tracking.chat_count  + EXCLUDED.chat_count,
                        voice_count = usage_tracking.voice_count + EXCLUDED.voice_count
                    """,
                    user_id,
                    chat,
                    voice,
                )
        except Exception:
            logger.exception("Failed to update usage_tracking for user %s", user_id)
