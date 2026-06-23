"""
Text-to-Speech using pyttsx3 (local, no API needed).
"""

import threading
from typing import Optional


class TextToSpeech:
    """Local text-to-speech using pyttsx3."""

    def __init__(self, config):
        self.config = config
        self._engine = None
        self._initialized = False
        self._lock = threading.Lock()

    def _ensure_engine(self):
        """Lazy-initialize the TTS engine."""
        if self._initialized:
            return

        try:
            import pyttsx3
            self._engine = pyttsx3.init()
            self._engine.setProperty("rate", self.config.voice_tts_rate)

            # Set voice if specified
            voice_id = self.config.voice_tts_voice_id
            if voice_id:
                voices = self._engine.getProperty("voices")
                for v in voices:
                    if voice_id in v.id or voice_id in v.name:
                        self._engine.setProperty("voice", v.id)
                        break

            self._initialized = True
            print("[TTS] Engine initialized.")
        except ImportError:
            print("[TTS] pyttsx3 not installed. Run: pip install pyttsx3")
        except Exception as e:
            print(f"[TTS] Failed to initialize: {e}")

    def speak(self, text: str, wait: bool = True) -> None:
        """Speak text aloud.

        Args:
            text: Text to speak
            wait: If True, block until speaking finishes. If False, speak in background.
        """
        if not text or not text.strip():
            return

        # Strip markdown and special chars for cleaner speech
        clean = self._clean_text(text)

        if not clean:
            return

        self._ensure_engine()
        if not self._engine:
            return

        def _speak():
            with self._lock:
                try:
                    self._engine.say(clean)
                    self._engine.runAndWait()
                except Exception as e:
                    print(f"[TTS] Speak error: {e}")

        if wait:
            _speak()
        else:
            threading.Thread(target=_speak, daemon=True).start()

    def stop(self) -> None:
        """Stop current speech."""
        self._ensure_engine()
        if self._engine:
            try:
                self._engine.stop()
            except Exception:
                pass

    def list_voices(self) -> list:
        """List available TTS voices."""
        self._ensure_engine()
        if not self._engine:
            return []

        voices = self._engine.getProperty("voices")
        return [
            {"id": v.id, "name": v.name, "lang": v.languages}
            for v in voices
        ]

    def set_rate(self, rate: int) -> None:
        """Set speech rate (words per minute)."""
        self._ensure_engine()
        if self._engine:
            self._engine.setProperty("rate", rate)

    @staticmethod
    def _clean_text(text: str) -> str:
        """Clean text for speech — remove markdown, code blocks, etc."""
        import re
        # Remove code blocks
        text = re.sub(r"```[\s\S]*?```", "", text)
        # Remove inline code
        text = re.sub(r"`[^`]+`", "", text)
        # Remove markdown links
        text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
        # Remove markdown bold/italic
        text = re.sub(r"\*+([^*]+)\*+", r"\1", text)
        # Remove special chars
        text = re.sub(r"[#*_\[\](){}|>~]", " ", text)
        # Collapse whitespace
        text = re.sub(r"\s+", " ", text).strip()
        return text
