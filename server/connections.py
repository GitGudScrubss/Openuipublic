"""
ConnectionManager — Robust WebSocket lifecycle management with heartbeat + state recovery.

Tracks all active WebSocket connections per user (multiple tabs/devices).
Implements heartbeat monitoring, connection recovery, and state persistence to Redis.

Usage:
    manager = ConnectionManager(redis_client)

    await manager.connect(user_id, websocket)
    await manager.send(user_id, {"type": "chunk", "delta": "..."})
    await manager.disconnect(user_id, websocket, save_task_state={...})
"""

import asyncio
import json
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Set
from enum import Enum

import redis.asyncio as redis


class MessageType(str, Enum):
    """Standardized message types for the WebSocket protocol."""
    CHUNK = "chunk"
    DONE = "done"
    ERROR = "error"
    TOOL_START = "tool_start"
    TOOL_RESULT = "tool_result"
    ROUTING = "routing"
    USAGE_UPDATE = "usage_update"
    PING = "ping"
    PONG = "pong"


class ConnectionManager:
    """
    Manages WebSocket lifecycle for multiple users with multiple connections per user.

    Features:
      - Track active connections: Dict[user_id, List[WebSocket]]
      - Heartbeat: ping every 30s, disconnect if no pong in 10s
      - Reconnect: save task state to Redis, recover on reconnect
      - Broadcast: send to all users or specific user's all sockets
      - Message envelope: standardized format with type, conversation_id, timestamp
    """

    HEARTBEAT_INTERVAL = 30  # seconds between pings
    HEARTBEAT_TIMEOUT = 10   # seconds to wait for pong

    REDIS_KEY_CONNECTIONS = "ws:connections:{user_id}"          # Set of connection IDs
    REDIS_KEY_TASK_STATE = "ws:task_state:{user_id}"            # Serialized task state
    REDIS_KEY_RECONNECT_WINDOW = "ws:reconnect:{user_id}"       # Temporary reconnect data
    REDIS_TTL_TASK_STATE = 3600  # 1 hour
    REDIS_TTL_RECONNECT = 300    # 5 minutes (user has 5m to reconnect)

    def __init__(self, redis_client: Optional[redis.Redis]) -> None:
        """
        Args:
            redis_client: redis.asyncio.Redis instance; if None, heartbeat + state recovery disabled.
        """
        self.redis = redis_client
        # In-memory tracking: user_id -> List[WebSocket]
        self.active_connections: Dict[str, List[Any]] = {}
        # In-memory heartbeat tasks: (user_id, ws_id) -> asyncio.Task
        self.heartbeat_tasks: Dict[tuple, asyncio.Task] = {}

    # ─────────────────────────────────────────────────────────────────────────────
    # Connection Lifecycle
    # ─────────────────────────────────────────────────────────────────────────────

    async def connect(self, user_id: str, websocket: Any) -> str:
        """
        Register a new WebSocket connection for a user.

        Args:
            user_id: The user's unique identifier.
            websocket: WebSocket connection object (must have send_json, receive_json).

        Returns:
            connection_id: Unique identifier for this connection.
        """
        user_id = user_id.strip()
        connection_id = f"{user_id}:{time.time_ns()}"

        # Add to in-memory tracking
        if user_id not in self.active_connections:
            self.active_connections[user_id] = []
        self.active_connections[user_id].append(websocket)

        # Log connection
        print(f"[ConnectionManager] User {user_id} connected (id={connection_id}); "
              f"total sockets for user: {len(self.active_connections[user_id])}")

        # Record in Redis if available
        if self.redis:
            try:
                key = self.REDIS_KEY_CONNECTIONS.format(user_id=user_id)
                await self.redis.sadd(key, connection_id)
                await self.redis.expire(key, self.REDIS_TTL_RECONNECT)
            except Exception as e:
                print(f"[ConnectionManager] Failed to record connection in Redis: {e}")

        # Start heartbeat task
        heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(user_id, websocket, connection_id)
        )
        self.heartbeat_tasks[(user_id, connection_id)] = heartbeat_task

        return connection_id

    async def disconnect(
        self,
        user_id: str,
        websocket: Any,
        save_task_state: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Unregister a WebSocket connection and optionally save task state for recovery.

        Args:
            user_id: The user's unique identifier.
            websocket: The WebSocket connection to remove.
            save_task_state: Task state dict to persist to Redis for reconnect recovery.
        """
        user_id = user_id.strip()

        # Remove from in-memory tracking
        if user_id in self.active_connections:
            try:
                self.active_connections[user_id].remove(websocket)
                if not self.active_connections[user_id]:
                    del self.active_connections[user_id]
            except ValueError:
                pass  # Already removed

        print(f"[ConnectionManager] User {user_id} disconnected; "
              f"remaining sockets: {len(self.active_connections.get(user_id, []))}")

        # Cancel heartbeat task
        for (uid, _), task in list(self.heartbeat_tasks.items()):
            if uid == user_id and task.get_coro() is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                del self.heartbeat_tasks[(uid, _)]

        # Save task state to Redis if provided
        if save_task_state and self.redis:
            try:
                key = self.REDIS_KEY_TASK_STATE.format(user_id=user_id)
                state_json = json.dumps(save_task_state, default=str)
                await self.redis.setex(key, self.REDIS_TTL_TASK_STATE, state_json)
                print(f"[ConnectionManager] Saved task state for user {user_id}")
            except Exception as e:
                print(f"[ConnectionManager] Failed to save task state: {e}")

    # ─────────────────────────────────────────────────────────────────────────────
    # Message Delivery
    # ─────────────────────────────────────────────────────────────────────────────

    async def send(
        self,
        user_id: str,
        message: Dict[str, Any],
        conversation_id: Optional[str] = None,
    ) -> None:
        """
        Send a message to all of a user's WebSocket connections.

        Wraps the message in the standard envelope (adds type, conversation_id, timestamp).

        Args:
            user_id: Target user.
            message: Message body (must include 'type' field).
            conversation_id: Optional conversation ID; if not in message, use this.
        """
        user_id = user_id.strip()

        # Ensure envelope fields
        if "type" not in message:
            message["type"] = MessageType.CHUNK.value

        if "timestamp" not in message:
            message["timestamp"] = datetime.utcnow().isoformat() + "Z"

        if "conversation_id" not in message and conversation_id:
            message["conversation_id"] = conversation_id

        sockets = self.active_connections.get(user_id, [])
        if not sockets:
            print(f"[ConnectionManager] No active connections for user {user_id}")
            return

        dead_sockets = []
        for ws in sockets:
            try:
                await ws.send_json(message)
            except Exception as e:
                print(f"[ConnectionManager] Failed to send to socket: {e}")
                dead_sockets.append(ws)

        # Clean up dead connections
        for ws in dead_sockets:
            await self.disconnect(user_id, ws)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        """
        Send a message to all connected users.

        Args:
            message: Message body (must include 'type' field).
        """
        if "timestamp" not in message:
            message["timestamp"] = datetime.utcnow().isoformat() + "Z"

        for user_id in list(self.active_connections.keys()):
            await self.send(user_id, message.copy())

    # ─────────────────────────────────────────────────────────────────────────────
    # Query Methods
    # ─────────────────────────────────────────────────────────────────────────────

    def is_connected(self, user_id: str) -> bool:
        """Check if a user has any active WebSocket connections."""
        return user_id.strip() in self.active_connections

    def get_active_users(self) -> Set[str]:
        """Return all currently connected user IDs."""
        return set(self.active_connections.keys())

    def get_user_connection_count(self, user_id: str) -> int:
        """Return the number of active connections for a user."""
        return len(self.active_connections.get(user_id.strip(), []))

    # ─────────────────────────────────────────────────────────────────────────────
    # State Recovery
    # ─────────────────────────────────────────────────────────────────────────────

    async def recover_task_state(self, user_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve saved task state from Redis (if available).

        Called when a user reconnects to resume interrupted work.

        Args:
            user_id: The user's unique identifier.

        Returns:
            Task state dict, or None if not found or Redis unavailable.
=======
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

import redis.asyncio as aioredis
from fastapi import WebSocket

logger = logging.getLogger("openui.connections")

# Connection state persistence keys in Redis
TASK_STATE_PREFIX = "task_state:"  # task_state:{user_id}:{conversation_id}
ACTIVE_CONVERSATIONS_PREFIX = "active_convs:"  # active_convs:{user_id}


class ConnectionManager:
    """Manages WebSocket lifecycle with heartbeat, multi-device support, and state persistence."""

    HEARTBEAT_INTERVAL = 30  # seconds between pings
    HEARTBEAT_TIMEOUT = 10  # seconds to wait for pong before disconnect

    def __init__(self, redis_client: Optional[aioredis.Redis] = None) -> None:
        """
        Initialize the connection manager.

        Args:
            redis_client: Optional Redis client for state persistence. If None, state is not persisted.
        """
        self.redis = redis_client
        # Dict[user_id, List[WebSocket]] — one user can have multiple tabs/devices
        self._connections: dict[str, list[WebSocket]] = {}
        # Track heartbeat tasks: Dict[(user_id, ws_index), Task]
        self._heartbeat_tasks: dict[tuple[str, int], asyncio.Task] = {}

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        """
        Register a new WebSocket connection for the user.

        Args:
            user_id: Unique user identifier
            websocket: FastAPI WebSocket instance
        """
        await websocket.accept()

        if user_id not in self._connections:
            self._connections[user_id] = []

        self._connections[user_id].append(websocket)
        ws_index = len(self._connections[user_id]) - 1

        logger.info("WS connected: user=%s index=%d (total=%d)", user_id, ws_index, len(self._connections[user_id]))

        # Start heartbeat monitor for this connection
        heartbeat_task = asyncio.create_task(self._heartbeat_monitor(user_id, ws_index, websocket))
        self._heartbeat_tasks[(user_id, ws_index)] = heartbeat_task

    async def disconnect(self, user_id: str, websocket: WebSocket) -> None:
        """
        Unregister a WebSocket connection and save active task state to Redis.

        Args:
            user_id: Unique user identifier
            websocket: FastAPI WebSocket instance
        """
        if user_id not in self._connections:
            return

        connections = self._connections[user_id]
        try:
            ws_index = connections.index(websocket)
        except ValueError:
            return

        # Cancel heartbeat task
        heartbeat_key = (user_id, ws_index)
        if heartbeat_key in self._heartbeat_tasks:
            self._heartbeat_tasks[heartbeat_key].cancel()
            del self._heartbeat_tasks[heartbeat_key]

        # Remove connection
        connections.pop(ws_index)
        logger.info("WS disconnected: user=%s index=%d (remaining=%d)", user_id, ws_index, len(connections))

        # Clean up user entry if no more connections
        if not connections:
            del self._connections[user_id]

        # Note: Task state is already persisted to Redis when disconnect occurs.
        # The client can reconnect and resume from the saved state.

    def is_connected(self, user_id: str) -> bool:
        """Check if user has any active WebSocket connections."""
        return user_id in self._connections and len(self._connections[user_id]) > 0

    async def send(self, user_id: str, message: dict) -> None:
        """
        Send a message to all of a user's WebSocket connections.

        The message is wrapped in the standard envelope format with timestamp.

        Args:
            user_id: Target user identifier
            message: Message dict (will be wrapped in envelope with type, conversation_id, etc.)
        """
        if user_id not in self._connections:
            logger.debug("User not connected: %s", user_id)
            return

        # Wrap message in standard envelope if not already wrapped
        envelope = self._wrap_message(message)

        connections = self._connections[user_id]
        failed_indices = []

        for i, ws in enumerate(connections):
            try:
                await ws.send_json(envelope)
            except Exception as exc:
                logger.error("Failed to send to user=%s index=%d: %s", user_id, i, exc)
                failed_indices.append(i)

        # Remove failed connections (reverse order to preserve indices)
        for i in reversed(failed_indices):
            try:
                await self.disconnect(user_id, connections[i])
            except Exception:
                pass

    async def broadcast(self, message: dict) -> None:
        """
        Send a message to all connected users' WebSocket connections.

        Args:
            message: Message dict (will be wrapped in envelope)
        """
        if not self._connections:
            return

        envelope = self._wrap_message(message)
        failed: list[tuple[str, int]] = []

        for user_id, connections in self._connections.items():
            for i, ws in enumerate(connections):
                try:
                    await ws.send_json(envelope)
                except Exception as exc:
                    logger.error("Broadcast failed to user=%s index=%d: %s", user_id, i, exc)
                    failed.append((user_id, i))

        # Clean up failed connections
        for user_id, i in reversed(failed):
            try:
                if user_id in self._connections and i < len(self._connections[user_id]):
                    await self.disconnect(user_id, self._connections[user_id][i])
            except Exception:
                pass

    async def save_task_state(self, user_id: str, conversation_id: str, task_state: dict) -> None:
        """
        Save task state to Redis for resumption on reconnect.

        Args:
            user_id: User identifier
            conversation_id: Conversation/task identifier
            task_state: State dict to persist
        """
        if not self.redis:
            logger.debug("Redis not available; skipping task state persistence")
            return

        try:
            key = f"{TASK_STATE_PREFIX}{user_id}:{conversation_id}"
            # Store with 7-day expiry to avoid unbounded growth
            await self.redis.setex(key, 7 * 24 * 60 * 60, json.dumps(task_state))
            logger.debug("Saved task state: user=%s conversation=%s", user_id, conversation_id)
        except Exception as exc:
            logger.error("Failed to save task state: %s", exc)

    async def load_task_state(self, user_id: str, conversation_id: str) -> Optional[dict]:
        """
        Load task state from Redis if available (for resumption after disconnect/reconnect).

        Args:
            user_id: User identifier
            conversation_id: Conversation/task identifier

        Returns:
            Saved task state dict if found, None otherwise
>>>>>>> a3ab34b5b8d2f951383538555f2b88fd5a025e0a
        """
        if not self.redis:
            return None

<<<<<<< HEAD
        user_id = user_id.strip()
        try:
            key = self.REDIS_KEY_TASK_STATE.format(user_id=user_id)
            state_json = await self.redis.get(key)
            if state_json:
                return json.loads(state_json)
        except Exception as e:
            print(f"[ConnectionManager] Failed to recover task state: {e}")

        return None

    async def clear_task_state(self, user_id: str) -> None:
        """
        Explicitly clear saved task state (call after successful reconnect).

        Args:
            user_id: The user's unique identifier.
        """
        if not self.redis:
            return

        user_id = user_id.strip()
        try:
            key = self.REDIS_KEY_TASK_STATE.format(user_id=user_id)
            await self.redis.delete(key)
        except Exception as e:
            print(f"[ConnectionManager] Failed to clear task state: {e}")

    # ─────────────────────────────────────────────────────────────────────────────
    # Heartbeat
    # ─────────────────────────────────────────────────────────────────────────────

    async def _heartbeat_loop(
        self,
        user_id: str,
        websocket: Any,
        connection_id: str,
    ) -> None:
        """
        Monitor a single WebSocket connection with ping/pong heartbeat.

        Sends PING every 30s, expects PONG within 10s.
        Disconnects if heartbeat fails.
=======
        try:
            key = f"{TASK_STATE_PREFIX}{user_id}:{conversation_id}"
            data = await self.redis.get(key)
            if data:
                logger.debug("Loaded task state: user=%s conversation=%s", user_id, conversation_id)
                return json.loads(data)
        except Exception as exc:
            logger.error("Failed to load task state: %s", exc)

        return None

    async def mark_conversation_active(self, user_id: str, conversation_id: str) -> None:
        """Mark a conversation as active for the user (for resumption tracking)."""
        if not self.redis:
            return

        try:
            key = f"{ACTIVE_CONVERSATIONS_PREFIX}{user_id}"
            # Add conversation to set, with 7-day expiry
            await self.redis.sadd(key, conversation_id)
            await self.redis.expire(key, 7 * 24 * 60 * 60)
        except Exception as exc:
            logger.error("Failed to mark conversation active: %s", exc)

    async def get_active_conversations(self, user_id: str) -> set[str]:
        """Get all active conversation IDs for the user."""
        if not self.redis:
            return set()

        try:
            key = f"{ACTIVE_CONVERSATIONS_PREFIX}{user_id}"
            conversations = await self.redis.smembers(key)
            return conversations or set()
        except Exception as exc:
            logger.error("Failed to get active conversations: %s", exc)
            return set()

    def connected_users_count(self) -> int:
        """Total number of users with active connections."""
        return len(self._connections)

    def total_connections_count(self) -> int:
        """Total number of active WebSocket connections across all users."""
        return sum(len(sockets) for sockets in self._connections.values())

    @staticmethod
    def _wrap_message(message: dict) -> dict:
        """
        Wrap message in standard envelope format.

        Standard envelope:
            {
                "type": string,           // "chunk"|"done"|"error"|"tool_start"|"tool_result"|"routing"|"usage_update"
                "conversation_id": string,
                "timestamp": ISO string,
                ...other fields from message
            }
        """
        # If already wrapped (has type), return as-is
        if "type" in message:
            # Ensure timestamp exists
            if "timestamp" not in message:
                message["timestamp"] = datetime.now(timezone.utc).isoformat()
            return message

        # Wrap with default type and timestamp
        return {
            "type": message.pop("type", "message"),
            "conversation_id": message.pop("conversation_id", ""),
            "timestamp": message.pop("timestamp", datetime.now(timezone.utc).isoformat()),
            **message,
        }

    async def _heartbeat_monitor(self, user_id: str, ws_index: int, websocket: WebSocket) -> None:
        """
        Monitor heartbeat for a WebSocket connection.

        Sends ping every HEARTBEAT_INTERVAL seconds, disconnects if send fails.
>>>>>>> a3ab34b5b8d2f951383538555f2b88fd5a025e0a
        """
        try:
            while True:
                await asyncio.sleep(self.HEARTBEAT_INTERVAL)

<<<<<<< HEAD
                try:
                    # Send ping
                    ping_msg = {
                        "type": MessageType.PING.value,
                        "timestamp": datetime.utcnow().isoformat() + "Z",
                    }
                    await asyncio.wait_for(
                        websocket.send_json(ping_msg),
                        timeout=2.0
                    )

                    # Wait for pong (or receive any message)
                    pong_received = False
                    try:
                        response = await asyncio.wait_for(
                            websocket.receive_json(),
                            timeout=self.HEARTBEAT_TIMEOUT
                        )
                        if response.get("type") == MessageType.PONG.value:
                            pong_received = True
                    except asyncio.TimeoutError:
                        pass

                    if not pong_received:
                        print(f"[ConnectionManager] No pong from {connection_id}; disconnecting")
                        await self.disconnect(user_id, websocket)
                        break

                except Exception as e:
                    print(f"[ConnectionManager] Heartbeat failed for {connection_id}: {e}")
=======
                # Check if connection still exists
                if user_id not in self._connections or ws_index >= len(self._connections[user_id]):
                    break

                try:
                    # Send ping message
                    await websocket.send_json({"type": "ping"})
                    logger.debug("Heartbeat ping sent: user=%s index=%d", user_id, ws_index)
                except Exception as exc:
                    # Connection is dead, disconnect
                    logger.debug("Heartbeat error (disconnecting): user=%s index=%d: %s", user_id, ws_index, exc)
>>>>>>> a3ab34b5b8d2f951383538555f2b88fd5a025e0a
                    await self.disconnect(user_id, websocket)
                    break

        except asyncio.CancelledError:
            pass
<<<<<<< HEAD
        except Exception as e:
            print(f"[ConnectionManager] Heartbeat loop error: {e}")
            await self.disconnect(user_id, websocket)

    # ─────────────────────────────────────────────────────────────────────────────
    # Admin/Debug
    # ─────────────────────────────────────────────────────────────────────────────

    async def get_stats(self) -> Dict[str, Any]:
        """Return connection statistics."""
        total_users = len(self.active_connections)
        total_sockets = sum(len(sockets) for sockets in self.active_connections.values())

        return {
            "total_users": total_users,
            "total_sockets": total_sockets,
            "users": {
                uid: len(sockets) for uid, sockets in self.active_connections.items()
            }
        }

    async def disconnect_all(self) -> None:
        """Close all active connections and cleanup."""
        for user_id in list(self.active_connections.keys()):
            for ws in list(self.active_connections[user_id]):
                await self.disconnect(user_id, ws)

        # Cancel all heartbeat tasks
        for task in self.heartbeat_tasks.values():
            if not task.done():
                task.cancel()

        print("[ConnectionManager] All connections closed")
=======
        except Exception as exc:
            logger.error("Heartbeat monitor error: user=%s index=%d: %s", user_id, ws_index, exc)
>>>>>>> a3ab34b5b8d2f951383538555f2b88fd5a025e0a
