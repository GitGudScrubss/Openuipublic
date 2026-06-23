"""
Audio Capture — Captures system audio (WASAPI loopback on Windows) and microphone audio.
Used to transcribe what others say in meetings as well as what the user/agent says.
"""

import time
import threading
from typing import Optional, Callable


class AudioCapture:
    """Captures microphone input and speaker loopback for transcription."""

    def __init__(self, config, on_audio_data: Optional[Callable[[bytes], None]] = None):
        """
        Args:
            config: OpenUI Config object
            on_audio_data: Callback that receives raw PCM audio bytes (16kHz, 16-bit, mono)
        """
        self.config = config
        self.on_audio_data = on_audio_data
        self._is_capturing = False
        self._mic_thread: Optional[threading.Thread] = None
        self._speaker_thread: Optional[threading.Thread] = None
        self._pyaudio = None
        self._mic_stream = None
        self._speaker_stream = None

    def start(self):
        """Start capturing both microphone and speaker loopback."""
        if self._is_capturing:
            return
        self._is_capturing = True

        try:
            import pyaudio
            self._pyaudio = pyaudio.PyAudio()
        except ImportError:
            print("[AudioCapture] pyaudio not installed. Cannot start audio capture.")
            self._is_capturing = False
            return

        # Start microphone capture
        try:
            self._mic_stream = self._pyaudio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=16000,
                input=True,
                frames_per_buffer=1024,
                stream_callback=self._mic_callback,
            )
            self._mic_stream.start_stream()
            print("[AudioCapture] Started microphone capture.")
        except Exception as e:
            print(f"[AudioCapture] Microphone capture failed to start: {e}")

        # Start speaker loopback capture (Windows WASAPI loopback)
        try:
            device_index = self._find_wasapi_loopback_device()
            if device_index is not None:
                # Loopback device usually matches default speaker sample rate, so we might need to convert/resample.
                # But for simplicity, we'll try opening it and falling back.
                device_info = self._pyaudio.get_device_info_by_index(device_index)
                channels = int(device_info.get("maxInputChannels", 2))
                rate = int(device_info.get("defaultSampleRate", 44100))

                self._speaker_stream = self._pyaudio.open(
                    format=pyaudio.paInt16,
                    channels=channels,
                    rate=rate,
                    input=True,
                    input_device_index=device_index,
                    frames_per_buffer=1024,
                    stream_callback=lambda in_data, f_c, t_i, status: self._speaker_callback(in_data, channels, rate),
                )
                self._speaker_stream.start_stream()
                print(f"[AudioCapture] Started speaker loopback capture on device {device_index}.")
            else:
                print("[AudioCapture] No WASAPI loopback device found. Speaker capture disabled.")
        except Exception as e:
            print(f"[AudioCapture] Speaker loopback capture failed to start: {e}")

    def stop(self):
        """Stop capturing."""
        self._is_capturing = False
        time.sleep(0.1)

        if self._mic_stream:
            try:
                self._mic_stream.stop_stream()
                self._mic_stream.close()
            except Exception:
                pass
            self._mic_stream = None

        if self._speaker_stream:
            try:
                self._speaker_stream.stop_stream()
                self._speaker_stream.close()
            except Exception:
                pass
            self._speaker_stream = None

        if self._pyaudio:
            try:
                self._pyaudio.terminate()
            except Exception:
                pass
            self._pyaudio = None
        print("[AudioCapture] Audio capture stopped.")

    def _find_wasapi_loopback_device(self) -> Optional[int]:
        """Find the WASAPI loopback device index (Windows only)."""
        if not self._pyaudio:
            return None

        # Look for Windows WASAPI host API
        wasapi_api_index = None
        for i in range(self._pyaudio.get_host_api_count()):
            api_info = self._pyaudio.get_host_api_info_by_index(i)
            if "WASAPI" in api_info.get("name", ""):
                wasapi_api_index = i
                break

        if wasapi_api_index is None:
            return None

        # Find loopback device (usually has "loopback" or matches default output device name)
        default_output_device = self._pyaudio.get_default_output_device_info()
        default_name = default_output_device.get("name", "")

        for i in range(self._pyaudio.get_device_count()):
            device_info = self._pyaudio.get_device_info_by_index(i)
            if device_info.get("hostApi") == wasapi_api_index and device_info.get("maxInputChannels", 0) > 0:
                name = device_info.get("name", "")
                # Often named like "Speakers (Loopback)" or "Output (Loopback)"
                if "loopback" in name.lower() or default_name in name:
                    return i

        # Fallback to any loopback device
        for i in range(self._pyaudio.get_device_count()):
            device_info = self._pyaudio.get_device_info_by_index(i)
            if device_info.get("hostApi") == wasapi_api_index and device_info.get("maxInputChannels", 0) > 0:
                if "loopback" in device_info.get("name", "").lower():
                    return i

        return None

    def _mic_callback(self, in_data, frame_count, time_info, status):
        """Handle incoming microphone audio data."""
        if self._is_capturing and self.on_audio_data:
            # Mic is already configured at 16000Hz mono 16-bit
            self.on_audio_data(in_data)
        return (in_data, self._pyaudio.paContinue)

    def _speaker_callback(self, in_data, channels, rate):
        """Handle incoming speaker audio data."""
        if self._is_capturing and self.on_audio_data:
            # Resample and downmix speaker loopback (typically 44.1/48kHz stereo) to 16kHz mono
            processed_data = self._resample_and_mono(in_data, channels, rate, 16000)
            if processed_data:
                self.on_audio_data(processed_data)
        return (in_data, self._pyaudio.paContinue)

    def _resample_and_mono(self, data: bytes, channels: int, original_rate: int, target_rate: int) -> bytes:
        """Resample audio data to target rate and downmix to mono (simple implementation)."""
        import numpy as np
        try:
            # Load PCM 16-bit data into numpy array
            audio_np = np.frombuffer(data, dtype=np.int16)
            if channels > 1:
                # Downmix to mono by averaging channels
                audio_np = audio_np.reshape(-1, channels)
                audio_np = audio_np.mean(axis=1).astype(np.int16)

            # Simple resample (linear interpolation or decimation)
            if original_rate != target_rate:
                duration = len(audio_np) / original_rate
                num_target_samples = int(duration * target_rate)
                if num_target_samples > 0:
                    audio_np = np.interp(
                        np.linspace(0, len(audio_np), num_target_samples),
                        np.arange(len(audio_np)),
                        audio_np
                    ).astype(np.int16)

            return audio_np.tobytes()
        except Exception as e:
            # Return raw if failed or numpy unavailable
            return data
