"""
Conversation memory with token-aware context window management.
Stores messages and trims old messages when context gets too large.
"""

import time
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field


@dataclass
class Message:
    """A single conversation message."""
    role: str  # system | user | assistant | tool
    content: str
    tool_call_id: Optional[str] = None
    tool_calls: Optional[List[Dict]] = None
    name: Optional[str] = None  # tool name for tool messages
    timestamp: float = field(default_factory=time.time)

    def to_openai_dict(self) -> dict:
        """Convert to OpenAI API message format."""
        msg = {"role": self.role, "content": self.content}
        if self.tool_call_id:
            msg["tool_call_id"] = self.tool_call_id
        if self.name:
            msg["name"] = self.name
        if self.tool_calls:
            msg["tool_calls"] = self.tool_calls # type: ignore
        return msg


class ConversationMemory:
    """Manages conversation history with intelligent trimming."""

    def __init__(self, max_context_tokens: int = 6000):
        self.max_context_tokens = max_context_tokens
        self.messages: List[Message] = []
        self._system_message: Optional[Message] = None

    @property
    def system_message(self) -> Optional[Message]:
        return self._system_message

    @system_message.setter
    def system_message(self, msg: Message):
        self._system_message = msg

    def add_user(self, content: str) -> Message:
        """Add a user message."""
        msg = Message(role="user", content=content)
        self.messages.append(msg)
        self._trim_if_needed()
        return msg

    def add_assistant(self, content: str, tool_calls: Optional[List[Dict]] = None) -> Message:
        """Add an assistant message (may include tool calls)."""
        msg = Message(role="assistant", content=content or "", tool_calls=tool_calls)
        self.messages.append(msg)
        self._trim_if_needed()
        return msg

    def add_tool_result(self, tool_name: str, tool_call_id: str, content: str) -> Message:
        """Add a tool execution result message."""
        msg = Message(
            role="tool",
            content=content,
            tool_call_id=tool_call_id,
            name=tool_name,
        )
        self.messages.append(msg)
        self._trim_if_needed()
        return msg

    def get_messages(self) -> List[dict]:
        """Get all messages in OpenAI API format, with system message first."""
        result = []
        if self._system_message:
            result.append(self._system_message.to_openai_dict())
        for msg in self.messages:
            result.append(msg.to_openai_dict())
        return result

    def get_last_user_message(self) -> Optional[str]:
        """Get the most recent user message content."""
        for msg in reversed(self.messages):
            if msg.role == "user":
                return msg.content
        return None

    def clear(self):
        """Clear all conversation history (keep system message)."""
        self.messages.clear()

    def _trim_if_needed(self):
        """Remove oldest non-system messages if estimated token count exceeds limit."""
        estimated_tokens = self._estimate_tokens()
        if estimated_tokens <= self.max_context_tokens:
            return

        # Remove oldest messages (in pairs: user + assistant) until under limit
        while estimated_tokens > self.max_context_tokens and len(self.messages) > 2:
            # Remove the oldest pair
            removed = self.messages.pop(0)
            estimated_tokens -= self._estimate_message_tokens(removed)
            # Also remove the next message if it's a tool result or assistant response
            if self.messages and self.messages[0].role in ("assistant", "tool"):
                removed2 = self.messages.pop(0)
                estimated_tokens -= self._estimate_message_tokens(removed2)

    def _estimate_tokens(self) -> int:
        """Rough token estimation: ~4 chars per token."""
        total_chars = 0
        if self._system_message:
            total_chars += len(self._system_message.content)
        for msg in self.messages:
            total_chars += len(msg.content)
        return total_chars // 4

    @staticmethod
    def _estimate_message_tokens(msg: Message) -> int:
        """Estimate tokens for a single message."""
        return max(1, len(msg.content) // 4)

    def get_summary(self) -> str:
        """Get a summary of conversation state."""
        user_msgs = sum(1 for m in self.messages if m.role == "user")
        assistant_msgs = sum(1 for m in self.messages if m.role == "assistant")
        tool_msgs = sum(1 for m in self.messages if m.role == "tool")
        return (
            f"Conversation: {user_msgs} user, {assistant_msgs} assistant, "
            f"{tool_msgs} tool messages. ~{self._estimate_tokens()} tokens."
        )
