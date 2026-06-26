"""
CodeAgent — Coding-specialized agent that routes to Ollama with WebSocket streaming.

Usage:
    agent = CodeAgent(router, tier="free")
    for event in agent.stream(messages):
        ws.send(json.dumps(event))

Event protocol:
    {"type": "chunk",  "delta": "<token>"}
    {"type": "done",   "model": "<name>", "latency_ms": <n>}
    {"type": "error",  "message": "<msg>"}   # error notified, then cloud fallback begins
"""

import os
import time
from typing import List, Dict, Optional, Generator, Any

from openai import OpenAI, APIConnectionError, APIError, APITimeoutError

from core.router import ModelRouter
from server.tiers import TierId


CODE_SYSTEM_PROMPT = (
    "You are a coding assistant integrated into OpenUI, an AI desktop agent.\n\n"
    "Guidelines:\n"
    "- Write clean, readable, well-structured code\n"
    "- Explain your changes clearly and concisely\n"
    "- Follow the existing patterns and conventions in the codebase\n"
    "- Add a comment only where the intent is non-obvious\n"
    "- Prefer idiomatic solutions over clever ones\n"
    "- When modifying existing code, preserve the surrounding style\n"
    "- Point out potential bugs or edge cases in code under review\n"
    "- Suggest tests when introducing new functionality"
)

# Ollama models available per subscription tier (ordered best-first)
TIER_MODELS: Dict[TierId, List[str]] = {
    TierId.FREE:       ["llama3:8b", "codellama:7b"],
    TierId.PRO:        ["llama3:70b", "codellama:34b"],
    TierId.ENTERPRISE: ["llama3:70b", "codellama:34b"],  # + any user-configured endpoint
}

FALLBACK_MODEL = "claude-haiku-4-5-20251001"


class CodeAgent:
    """
    Coding-specialized agent that streams Ollama responses over a WebSocket channel.

    Wraps ModelRouter to reuse its OpenAI client and config.  Adds:
    - Token-by-token streaming
    - Tier-based Ollama model selection
    - Graceful cloud fallback (claude-haiku-4-5-20251001) when Ollama is offline
    """

    def __init__(
        self,
        router: ModelRouter,
        tier: str = TierId.FREE,
        model_override: Optional[str] = None,
        custom_ollama_url: Optional[str] = None,
    ):
        """
        Args:
            router: Existing ModelRouter — its config and client are reused.
            tier: Subscription tier string ("free" | "pro" | "enterprise").
            model_override: Force a specific Ollama model, bypassing tier defaults.
            custom_ollama_url: Enterprise custom Ollama endpoint (e.g. http://gpu-box:11434/v1).
        """
        self.router = router
        self.tier = TierId(tier) if isinstance(tier, str) else tier

        # Determine which Ollama model to use
        if model_override:
            self.model = model_override
        else:
            self.model = TIER_MODELS.get(self.tier, TIER_MODELS[TierId.FREE])[0]

        # Reuse router's OpenAI client; swap base_url for Enterprise custom endpoints
        if custom_ollama_url:
            self._ollama_client = OpenAI(
                base_url=custom_ollama_url,
                api_key=router.config.model_api_key,
                timeout=router.config.model_timeout,
            )
        else:
            self._ollama_client = router.client  # shared, no extra cost

        self._anthropic_client: Optional[Any] = None  # lazy-initialized on first fallback

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def stream(
        self,
        messages: List[Dict],
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> Generator[Dict, None, None]:
        """
        Stream a code completion, yielding WebSocket-ready event dicts.

        Args:
            messages: Conversation history in OpenAI message format.
            temperature: Override temperature (defaults to router config).
            max_tokens: Override max tokens (defaults to router config).

        Yields:
            {"type": "chunk",  "delta": str}
            {"type": "done",   "model": str, "latency_ms": float}
            {"type": "error",  "message": str}
        """
        full_messages = self._inject_system_prompt(messages)
        temp = temperature if temperature is not None else self.router.config.model_temperature
        tokens = max_tokens or self.router.config.model_max_tokens

        yield from self._ollama_stream(full_messages, temp, tokens)

    def is_model_allowed(self, model: str) -> bool:
        """Return True if *model* is accessible under the current tier."""
        if self.tier == TierId.ENTERPRISE:
            return True
        return model in TIER_MODELS.get(self.tier, [])

    def available_models(self) -> List[str]:
        """Return the list of Ollama models available for the current tier."""
        if self.tier == TierId.ENTERPRISE:
            return TIER_MODELS[TierId.ENTERPRISE] + ["<any user-configured endpoint>"]
        return TIER_MODELS.get(self.tier, TIER_MODELS[TierId.FREE])

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _inject_system_prompt(self, messages: List[Dict]) -> List[Dict]:
        """Prepend the coding system prompt unless one already exists."""
        if messages and messages[0].get("role") == "system":
            return messages
        return [{"role": "system", "content": CODE_SYSTEM_PROMPT}] + messages

    def _ollama_stream(
        self,
        messages: List[Dict],
        temperature: float,
        max_tokens: int,
    ) -> Generator[Dict, None, None]:
        """Attempt streaming from Ollama; fall back to cloud on connection failure."""
        start = time.time()
        emitted_chunks = False

        try:
            stream = self._ollama_client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True,
            )
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    emitted_chunks = True
                    yield {"type": "chunk", "delta": delta}

            if emitted_chunks:
                latency = round((time.time() - start) * 1000, 1)
                yield {"type": "done", "model": self.model, "latency_ms": latency}
                return

            # Stream completed but no tokens — treat as Ollama unavailable
            raise APIConnectionError(
                request=None,  # type: ignore[arg-type]
                message="Ollama returned empty stream",
            )

        except (APIConnectionError, APITimeoutError):
            # Ollama unreachable or timed out — cloud fallback
            pass
        except APIError as exc:
            err = str(exc).lower()
            if any(k in err for k in ("connect", "connection", "refused", "unreachable")):
                pass  # Ollama down — fall through to cloud
            else:
                yield {"type": "error", "message": str(exc)}
                return
        except Exception as exc:
            if emitted_chunks:
                # Partial response already sent; surface the error without retrying
                yield {"type": "error", "message": str(exc)}
                return
            # No chunks yet — assume startup failure, fall through

        yield {
            "type": "error",
            "message": "Local AI offline. Falling back to cloud...",
        }
        yield from self._anthropic_stream(messages, temperature, max_tokens)

    def _anthropic_stream(
        self,
        messages: List[Dict],
        temperature: float,
        max_tokens: int,
    ) -> Generator[Dict, None, None]:
        """Stream from Anthropic claude-haiku-4-5-20251001 as the cloud fallback."""
        start = time.time()
        try:
            client = self._get_anthropic_client()

            # Separate system message from the conversation
            system_content = CODE_SYSTEM_PROMPT
            chat_messages: List[Dict] = []
            for m in messages:
                if m["role"] == "system":
                    system_content = m["content"]
                else:
                    chat_messages.append({"role": m["role"], "content": m["content"]})

            with client.messages.stream(
                model=FALLBACK_MODEL,
                system=system_content,
                messages=chat_messages,
                temperature=temperature,
                max_tokens=max_tokens,
            ) as stream:
                for text in stream.text_stream:
                    yield {"type": "chunk", "delta": text}

            latency = round((time.time() - start) * 1000, 1)
            yield {"type": "done", "model": FALLBACK_MODEL, "latency_ms": latency}

        except Exception as exc:
            yield {"type": "error", "message": f"Cloud fallback failed: {exc}"}

    def _get_anthropic_client(self) -> Any:
        """Lazy-initialize the Anthropic client (avoids import cost when unused)."""
        if self._anthropic_client is None:
            try:
                import anthropic
            except ImportError as exc:
                raise ImportError(
                    "anthropic package is required for cloud fallback. "
                    "Install it: pip install anthropic"
                ) from exc
            self._anthropic_client = anthropic.Anthropic(
                api_key=os.environ.get("ANTHROPIC_API_KEY", "")
            )
        return self._anthropic_client
