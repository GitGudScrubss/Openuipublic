"""
OpenUI Configuration
Central config loaded from config.yaml or environment variables.
"""

import os
import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, List


DEFAULT_CONFIG = {
    "model": {
        "provider": "ollama",          # ollama | openai | anthropic
        "base_url": "http://localhost:11434/v1",
        "model_name": "qwen2.5-coder:7b",
        "api_key": "ollama",           # Ollama doesn't need real key
        "temperature": 0.1,
        "max_tokens": 4096,
        "timeout": 120,
        "vision_model": "qwen2.5-coder:7b",  # model for screen description
    },
    "agent": {
        "max_tool_iterations": 15,     # max tool calls per user command
        "max_context_tokens": 6000,    # trim memory to this
        "verbose": True,
        "auto_speak": True,            # TTS every response
    },
    "voice": {
        "stt_engine": "whisper",       # whisper | google
        "stt_model": "base",           # tiny/base/small/medium
        "tts_engine": "pyttsx3",       # pyttsx3 | piper
        "tts_rate": 170,
        "tts_voice_id": None,          # None = system default
        "listen_hotkey": "ctrl+alt+o", # hotkey to start listening
        "stop_hotkey": "escape",       # hotkey to stop
        "wake_word": "openui",         # wake word
        "continuous": True,            # continuous listening mode
    },
    "screen": {
        "ocr_engine": "tesseract",     # tesseract | paddleocr
        "capture_scale": 1.0,          # downscale factor for screenshots
        "max_screenshot_size": 1920,
    },
    "ui": {
        "overlay": True,               # show floating overlay
        "overlay_opacity": 0.85,
        "overlay_position": "top-right",
        "system_tray": True,
        "theme": "light",
        "font_size": 14,
    },
    "tools": {
        "terminal": True,
        "screen_capture": True,
        "mouse_control": True,
        "keyboard_control": True,
        "browser": True,
        "file_ops": True,
    },
    "safety": {
        "confirm_destructive": True,   # confirm rm -rf, format, etc.
        "blocked_commands": ["rm -rf /", "format", "mkfs", "dd if="],
        "max_terminal_output": 5000,   # chars per response
    },
}


@dataclass
class Config:
    """Typed config object."""
    model_provider: str = "ollama"
    model_base_url: str = "http://localhost:11434/v1"
    model_name: str = "qwen2.5-coder:7b"
    model_api_key: str = "ollama"
    model_temperature: float = 0.1
    model_max_tokens: int = 4096
    model_timeout: int = 120
    vision_model: str = "qwen2.5-coder:7b"

    agent_max_tool_iterations: int = 15
    agent_max_context_tokens: int = 6000
    agent_verbose: bool = True
    agent_auto_speak: bool = True

    voice_stt_engine: str = "whisper"
    voice_stt_model: str = "base"
    voice_tts_engine: str = "pyttsx3"
    voice_tts_rate: int = 170
    voice_tts_voice_id: Optional[str] = None
    voice_listen_hotkey: str = "ctrl+alt+o"
    voice_stop_hotkey: str = "escape"
    voice_wake_word: str = "openui"
    voice_continuous: bool = True

    screen_ocr_engine: str = "tesseract"
    screen_capture_scale: float = 1.0

    ui_overlay: bool = True
    ui_system_tray: bool = True
    ui_theme: str = "light"

    tools_terminal: bool = True
    tools_screen_capture: bool = True
    tools_mouse_control: bool = True
    tools_keyboard_control: bool = True
    tools_browser: bool = True
    tools_file_ops: bool = True

    safety_confirm_destructive: bool = True
    safety_blocked_commands: List[str] = field(default_factory=lambda: ["rm -rf /", "format", "mkfs", "dd if="])
    safety_max_terminal_output: int = 5000

    config_path: Optional[str] = None

    @classmethod
    def from_yaml(cls, path: str) -> "Config":
        """Load config from YAML file."""
        with open(path, "r") as f:
            user_config = yaml.safe_load(f) or {}
        return cls._merge(DEFAULT_CONFIG, user_config)

    @classmethod
    def from_env(cls) -> "Config":
        """Load config from environment variables with OPENUI_ prefix."""
        cfg = cls()
        env_map = {
            "OPENUI_MODEL_PROVIDER": "model_provider",
            "OPENUI_MODEL_NAME": "model_name",
            "OPENUI_BASE_URL": "model_base_url",
            "OPENUI_API_KEY": "model_api_key",
            "OPENUI_TEMPERATURE": "model_temperature",
        }
        for env_key, attr in env_map.items():
            val = os.environ.get(env_key)
            if val is not None:
                if attr == "model_temperature":
                    setattr(cfg, attr, float(val))
                else:
                    setattr(cfg, attr, val)
        return cfg

    @classmethod
    def _merge(cls, defaults: dict, overrides: dict) -> "Config":
        """Deep merge user overrides into defaults and create Config."""
        def deep_merge(base, override):
            result = base.copy()
            for k, v in override.items():
                if k in result and isinstance(result[k], dict) and isinstance(v, dict):
                    result[k] = deep_merge(result[k], v)
                else:
                    result[k] = v
            return result

        merged = deep_merge(defaults, overrides)

        # Flatten to Config
        m = merged["model"]
        a = merged["agent"]
        v = merged["voice"]
        s = merged["screen"]
        u = merged["ui"]
        t = merged["tools"]
        sf = merged["safety"]

        return cls(
            model_provider=m.get("provider", "ollama"),
            model_base_url=m.get("base_url", "http://localhost:11434/v1"),
            model_name=m.get("model_name", "qwen2.5-coder:7b"),
            model_api_key=m.get("api_key", "ollama"),
            model_temperature=m.get("temperature", 0.1),
            model_max_tokens=m.get("max_tokens", 4096),
            model_timeout=m.get("timeout", 120),
            vision_model=m.get("vision_model", "qwen2.5-coder:7b"),
            agent_max_tool_iterations=a.get("max_tool_iterations", 15),
            agent_max_context_tokens=a.get("max_context_tokens", 6000),
            agent_verbose=a.get("verbose", True),
            agent_auto_speak=a.get("auto_speak", True),
            voice_stt_engine=v.get("stt_engine", "whisper"),
            voice_stt_model=v.get("stt_model", "base"),
            voice_tts_engine=v.get("tts_engine", "pyttsx3"),
            voice_tts_rate=v.get("tts_rate", 170),
            voice_tts_voice_id=v.get("tts_voice_id"),
            voice_listen_hotkey=v.get("listen_hotkey", "ctrl+alt+o"),
            voice_stop_hotkey=v.get("stop_hotkey", "escape"),
            voice_wake_word=v.get("wake_word", "openui"),
            voice_continuous=v.get("continuous", True),
            screen_ocr_engine=s.get("ocr_engine", "tesseract"),
            screen_capture_scale=s.get("capture_scale", 1.0),
            ui_overlay=u.get("overlay", True),
            ui_system_tray=u.get("system_tray", True),
            ui_theme=u.get("theme", "light"),
            tools_terminal=t.get("terminal", True),
            tools_screen_capture=t.get("screen_capture", True),
            tools_mouse_control=t.get("mouse_control", True),
            tools_keyboard_control=t.get("keyboard_control", True),
            tools_browser=t.get("browser", True),
            tools_file_ops=t.get("file_ops", True),
            safety_confirm_destructive=sf.get("confirm_destructive", True),
            safety_blocked_commands=sf.get("blocked_commands", ["rm -rf /"]),
            safety_max_terminal_output=sf.get("max_terminal_output", 5000),
        )

    def save_yaml(self, path: str):
        """Save current config to YAML."""
        # Reconstruct dict
        data = {
            "model": {
                "provider": self.model_provider,
                "base_url": self.model_base_url,
                "model_name": self.model_name,
                "api_key": self.model_api_key,
                "temperature": self.model_temperature,
                "max_tokens": self.model_max_tokens,
                "timeout": self.model_timeout,
                "vision_model": self.vision_model,
            },
            "agent": {
                "max_tool_iterations": self.agent_max_tool_iterations,
                "max_context_tokens": self.agent_max_context_tokens,
                "verbose": self.agent_verbose,
                "auto_speak": self.agent_auto_speak,
            },
            "voice": {
                "stt_engine": self.voice_stt_engine,
                "stt_model": self.voice_stt_model,
                "tts_engine": self.voice_tts_engine,
                "tts_rate": self.voice_tts_rate,
                "tts_voice_id": self.voice_tts_voice_id,
                "listen_hotkey": self.voice_listen_hotkey,
                "stop_hotkey": self.voice_stop_hotkey,
                "wake_word": self.voice_wake_word,
                "continuous": self.voice_continuous,
            },
            "safety": {
                "confirm_destructive": self.safety_confirm_destructive,
                "blocked_commands": self.safety_blocked_commands,
                "max_terminal_output": self.safety_max_terminal_output,
            },
        }
        with open(path, "w") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)


def load_config(config_path: Optional[str] = None) -> Config:
    """Load config from file, env, or defaults."""
    # Priority: explicit path > ./config.yaml > ~/.openui/config.yaml > env > defaults
    search_paths = [
        config_path,
        "config.yaml",
        str(Path.home() / ".openui" / "config.yaml"),
    ]
    for p in search_paths:
        if p and Path(p).exists():
            cfg = Config.from_yaml(p)
            cfg.config_path = str(Path(p).resolve())
            return cfg
    return Config.from_env()
