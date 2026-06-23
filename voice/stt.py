"""
Speech-to-Text using faster-whisper (local, no API needed) with streaming VAD and wake word.
"""

import tempfile
import wave
import threading
import time
import struct
import math
from typing import Optional, Callable

class SpeechToText:
    """Local speech-to-text using faster-whisper with streaming VAD and wake word."""

    def __init__(self, config):
        self.config = config
        self.model = None
        self._is_listening = False
        self._audio_data = []
        self._stream = None
        self._pyaudio = None

        # Continuous listening / VAD / Wake word variables
        self._continuous_thread: Optional[threading.Thread] = None
        self._is_continuous = False
        self._on_command_callback: Optional[Callable[[str], None]] = None
        
        # Energy-based VAD settings
        self.vad_threshold = 1000  # RMS threshold for voice detection
        self.silence_limit_seconds = 1.5  # Seconds of silence to end speech
        self.wake_word = getattr(config, "voice_wake_word", "openui").lower()
        self.wake_word_detected = False

    def load_model(self):
        """Load the Whisper model (lazy loaded on first use)."""
        if self.model is not None:
            return

        model_size = self.config.voice_stt_model  # tiny, base, small, medium

        try:
            from faster_whisper import WhisperModel
            print(f"[STT] Loading Whisper model ({model_size})...")
            # Use int8 for lower memory usage
            self.model = WhisperModel(
                model_size,
                device="auto",
                compute_type="int8",
            )
            print("[STT] Whisper model loaded.")
        except ImportError:
            print("[STT] faster-whisper not installed. Run: pip install faster-whisper")
            raise
        except Exception as e:
            print(f"[STT] Failed to load model: {e}")
            raise

    def transcribe_file(self, audio_path: str) -> str:
        """Transcribe an audio file."""
        self.load_model()

        segments, info = self.model.transcribe(
            audio_path,
            language="en",
            beam_size=5,
            vad_filter=True,  # Filter out silence
        )

        text = " ".join(seg.text for seg in segments).strip()
        return text

    def transcribe_bytes(self, audio_bytes: bytes, sample_rate: int = 16000) -> str:
        """Transcribe raw audio bytes."""
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
            with wave.open(tmp_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(sample_rate)
                wf.writeframes(audio_bytes)

        try:
            return self.transcribe_file(tmp_path)
        finally:
            import os
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    def start_listening(self) -> None:
        """Start recording audio from microphone in a background thread."""
        if self._is_listening:
            print("[STT] Already listening...")
            return

        try:
            import pyaudio
            self._pyaudio = pyaudio
        except ImportError:
            print("[STT] pyaudio not installed. Run: pip install pyaudio")
            return

        self._audio_data = []
        self._is_listening = True

        self._stream = self._pyaudio.PyAudio().open(
            format=pyaudio.paInt16,
            channels=1,
            rate=16000,
            input=True,
            frames_per_buffer=1024,
            stream_callback=self._audio_callback,
        )

        self._stream.start_stream()
        print("[STT] Listening... (speak now)")

    def _audio_callback(self, in_data, frame_count, time_info, status):
        """Callback for audio stream."""
        if self._is_listening:
            self._audio_data.append(in_data)
        return (in_data, self._pyaudio.paContinue)

    def stop_listening(self) -> str:
        """Stop recording and transcribe."""
        if not self._is_listening:
            return ""

        self._is_listening = False

        if self._stream:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

        if not self._audio_data:
            return ""

        # Combine audio data
        raw_audio = b"".join(self._audio_data)
        self._audio_data = []

        if len(raw_audio) < 1600:  # Less than 0.1 seconds
            return ""

        # Transcribe
        try:
            text = self.transcribe_bytes(raw_audio, sample_rate=16000)
            if text:
                print(f"[STT] Heard: {text}")
            return text
        except Exception as e:
            print(f"[STT] Transcription error: {e}")
            return ""

    def start_continuous_listening(self, callback: Callable[[str], None]) -> None:
        """Start continuous listening in the background with VAD and wake word detection."""
        if self._is_continuous:
            return
        self._is_continuous = True
        self._on_command_callback = callback
        self._continuous_thread = threading.Thread(target=self._continuous_loop, daemon=True, name="STTContinuous")
        self._continuous_thread.start()
        print(f"[STT] Continuous listening started. Wake word: '{self.wake_word}'")

    def stop_continuous_listening(self):
        """Stop continuous listening."""
        self._is_continuous = False
        if self._continuous_thread:
            self._continuous_thread.join(timeout=2)
            self._continuous_thread = None
        print("[STT] Continuous listening stopped.")

    def _calculate_rms(self, frame_bytes: bytes) -> float:
        """Calculate RMS (volume/energy) of a PCM frame."""
        count = len(frame_bytes) // 2
        if count == 0:
            return 0.0
        format_str = f"<{count}h"
        try:
            shorts = struct.unpack(format_str, frame_bytes)
        except struct.error:
            return 0.0
        
        sum_squares = 0.0
        for sample in shorts:
            sum_squares += sample * sample
        return math.sqrt(sum_squares / count)

    def _continuous_loop(self):
        """Continuous listening and VAD loop."""
        import pyaudio
        p = pyaudio.PyAudio()

        try:
            stream = p.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=16000,
                input=True,
                frames_per_buffer=1024,
            )
        except Exception as e:
            print(f"[STT] Failed to open microphone stream: {e}")
            p.terminate()
            self._is_continuous = False
            return

        speech_buffer = []
        is_speaking = False
        silence_start = 0.0

        while self._is_continuous:
            try:
                data = stream.read(1024, exception_on_overflow=False)
            except Exception:
                continue

            rms = self._calculate_rms(data)

            if rms > self.vad_threshold:
                if not is_speaking:
                    is_speaking = True
                    print("[STT] Voice detected...")
                speech_buffer.append(data)
                silence_start = 0.0
            else:
                if is_speaking:
                    speech_buffer.append(data)
                    if silence_start == 0.0:
                        silence_start = time.time()
                    elif time.time() - silence_start > self.silence_limit_seconds:
                        # Silence threshold reached, process speech
                        is_speaking = False
                        full_speech = b"".join(speech_buffer)
                        speech_buffer = []
                        silence_start = 0.0
                        
                        threading.Thread(target=self._process_continuous_speech, args=(full_speech,), daemon=True).start()
                else:
                    # Keep a small rolling pre-speech buffer (e.g., last 3 frames / ~0.2 seconds) to avoid cutting off words
                    speech_buffer.append(data)
                    if len(speech_buffer) > 5:
                        speech_buffer.pop(0)

            time.sleep(0.01)

        try:
            stream.stop_stream()
            stream.close()
        except Exception:
            pass
        p.terminate()

    def _process_continuous_speech(self, audio_bytes: bytes):
        """Process captured speech, check wake word and pass command."""
        try:
            text = self.transcribe_bytes(audio_bytes, sample_rate=16000).strip()
            if not text:
                return

            print(f"[STT] Heard (continuous): '{text}'")

            text_lower = text.lower()

            if not self.wake_word_detected:
                # Check for wake word
                if self.wake_word in text_lower:
                    self.wake_word_detected = True
                    print(f"[STT] Wake word '{self.wake_word}' detected!")
                    # Strip wake word and check if there's an immediate command in the same sentence
                    command = text_lower.split(self.wake_word, 1)[1].strip()
                    if command and self._on_command_callback:
                        self._on_command_callback(command)
                else:
                    print(f"[STT] Ignored (no wake word): '{text}'")
            else:
                # Wake word was already detected, this is the command
                self.wake_word_detected = False  # Reset for next command
                if self._on_command_callback:
                    self._on_command_callback(text)

        except Exception as e:
            print(f"[STT] Error processing continuous speech: {e}")

    @property
    def is_listening(self) -> bool:
        return self._is_listening
