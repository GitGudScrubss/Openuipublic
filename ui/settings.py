"""
Settings panel for OpenUI.
Allows users to configure model, voice, tools, and safety settings.
"""

from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit,
    QComboBox, QSpinBox, QDoubleSpinBox, QCheckBox, QPushButton, QGroupBox,
    QTabWidget, QScrollArea, QFileDialog,
)
from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtGui import QFont


class SettingsWindow(QWidget):
    """Settings/configuration window for OpenUI."""

    settings_changed = pyqtSignal(dict)

    def __init__(self, config, parent=None):
        super().__init__(parent)
        self.config = config
        self.setWindowTitle("OpenUI Settings")
        self.setFixedSize(520, 600)
        self._build_ui()
        self._load_values()

    def _build_ui(self):
        """Build the settings UI."""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)

        # Title
        title = QLabel("Settings")
        title.setFont(QFont("Inter", 18, QFont.Bold))
        title.setStyleSheet("color: #1e293b; margin-bottom: 12px;")
        layout.addWidget(title)

        # Tab widget
        tabs = QTabWidget()
        tabs.setStyleSheet("""
            QTabWidget::pane { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
            QTabBar::tab { padding: 8px 16px; margin-right: 4px; }
            QTabBar::tab:selected { background: #3b82f6; color: white; border-radius: 6px; }
        """)

        # Model tab
        tabs.addTab(self._build_model_tab(), "Model")
        # Voice tab
        tabs.addTab(self._build_voice_tab(), "Voice")
        # Tools tab
        tabs.addTab(self._build_tools_tab(), "Tools")
        # Safety tab
        tabs.addTab(self._build_safety_tab(), "Safety")

        layout.addWidget(tabs)

        # Bottom buttons
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        save_btn = QPushButton("Save Settings")
        save_btn.setObjectName("saveBtn")
        save_btn.setStyleSheet("""
            QPushButton#saveBtn {
                background: #3b82f6; color: white; border: none;
                border-radius: 8px; padding: 10px 24px; font-size: 14px;
            }
            QPushButton#saveBtn:hover { background: #2563eb; }
        """)
        save_btn.clicked.connect(self._save_settings)
        btn_layout.addWidget(save_btn)

        layout.addLayout(btn_layout)

    def _build_model_tab(self) -> QWidget:
        """Model configuration tab."""
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # Model provider
        layout.addWidget(QLabel("Model Provider"))
        self.provider_combo = QComboBox()
        self.provider_combo.addItems(["ollama", "openai", "anthropic"])
        layout.addWidget(self.provider_combo)

        # Base URL
        layout.addWidget(QLabel("Base URL"))
        self.base_url_input = QLineEdit()
        layout.addWidget(self.base_url_input)

        # Model name
        layout.addWidget(QLabel("Model Name"))
        self.model_name_input = QLineEdit()
        layout.addWidget(self.model_name_input)

        # Temperature
        layout.addWidget(QLabel("Temperature"))
        self.temp_spin = QDoubleSpinBox()
        self.temp_spin.setRange(0.0, 2.0)
        self.temp_spin.setSingleStep(0.1)
        self.temp_spin.setDecimals(1)
        layout.addWidget(self.temp_spin)

        # Max tokens
        layout.addWidget(QLabel("Max Tokens"))
        self.max_tokens_spin = QSpinBox()
        self.max_tokens_spin.setRange(256, 32768)
        self.max_tokens_spin.setSingleStep(256)
        layout.addWidget(self.max_tokens_spin)

        layout.addStretch()
        return widget

    def _build_voice_tab(self) -> QWidget:
        """Voice configuration tab."""
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # Auto-speak
        self.auto_speak_check = QCheckBox("Auto-speak responses")
        layout.addWidget(self.auto_speak_check)

        # TTS engine
        layout.addWidget(QLabel("TTS Engine"))
        self.tts_engine_combo = QComboBox()
        self.tts_engine_combo.addItems(["pyttsx3"])
        layout.addWidget(self.tts_engine_combo)

        # TTS rate
        layout.addWidget(QLabel("Speech Rate (WPM)"))
        self.tts_rate_spin = QSpinBox()
        self.tts_rate_spin.setRange(80, 400)
        self.tts_rate_spin.setValue(170)
        layout.addWidget(self.tts_rate_spin)

        # STT model
        layout.addWidget(QLabel("STT Model Size"))
        self.stt_model_combo = QComboBox()
        self.stt_model_combo.addItems(["tiny", "base", "small", "medium"])
        layout.addWidget(self.stt_model_combo)

        # Listen hotkey
        layout.addWidget(QLabel("Voice Hotkey"))
        self.hotkey_input = QLineEdit()
        self.hotkey_input.setPlaceholderText("e.g., ctrl+alt+o")
        layout.addWidget(self.hotkey_input)

        layout.addStretch()
        return widget

    def _build_tools_tab(self) -> QWidget:
        """Tool enable/disable tab."""
        widget = QWidget()
        layout = QVBoxLayout(widget)

        self.tool_checks = {}
        tools_info = [
            ("terminal", "Terminal Commands", True),
            ("screen_capture", "Screen Capture & OCR", True),
            ("mouse_control", "Mouse Control", True),
            ("keyboard_control", "Keyboard Control", True),
            ("browser", "Browser Control", True),
            ("file_ops", "File Operations", True),
        ]

        for key, label, default in tools_info:
            cb = QCheckBox(label)
            cb.setChecked(default)
            self.tool_checks[key] = cb
            layout.addWidget(cb)

        layout.addStretch()
        return widget

    def _build_safety_tab(self) -> QWidget:
        """Safety settings tab."""
        widget = QWidget()
        layout = QVBoxLayout(widget)

        # Confirm destructive
        self.confirm_destructive_check = QCheckBox("Confirm destructive commands")
        self.confirm_destructive_check.setChecked(True)
        layout.addWidget(self.confirm_destructive_check)

        # Max terminal output
        layout.addWidget(QLabel("Max Terminal Output (chars)"))
        self.max_output_spin = QSpinBox()
        self.max_output_spin.setRange(1000, 50000)
        self.max_output_spin.setSingleStep(1000)
        self.max_output_spin.setValue(5000)
        layout.addWidget(self.max_output_spin)

        layout.addStretch()
        return widget

    def _load_values(self):
        """Load current config values into the UI."""
        c = self.config
        self.provider_combo.setCurrentText(c.model_provider)
        self.base_url_input.setText(c.model_base_url)
        self.model_name_input.setText(c.model_name)
        self.temp_spin.setValue(c.model_temperature)
        self.max_tokens_spin.setValue(c.model_max_tokens)

        self.auto_speak_check.setChecked(c.agent_auto_speak)
        self.tts_rate_spin.setValue(c.voice_tts_rate)
        self.hotkey_input.setText(c.voice_listen_hotkey)

        idx = self.stt_model_combo.findText(c.voice_stt_model)
        if idx >= 0:
            self.stt_model_combo.setCurrentIndex(idx)

        self.confirm_destructive_check.setChecked(c.safety_confirm_destructive)
        self.max_output_spin.setValue(c.safety_max_terminal_output)

    def _save_settings(self):
        """Save UI values back to config and emit signal."""
        changes = {
            "model_provider": self.provider_combo.currentText(),
            "model_base_url": self.base_url_input.text(),
            "model_name": self.model_name_input.text(),
            "model_temperature": self.temp_spin.value(),
            "model_max_tokens": self.max_tokens_spin.value(),
            "agent_auto_speak": self.auto_speak_check.isChecked(),
            "voice_tts_rate": self.tts_rate_spin.value(),
            "voice_stt_model": self.stt_model_combo.currentText(),
            "voice_listen_hotkey": self.hotkey_input.text(),
            "safety_confirm_destructive": self.confirm_destructive_check.isChecked(),
            "safety_max_terminal_output": self.max_output_spin.value(),
        }

        # Apply to config
        for key, val in changes.items():
            if hasattr(self.config, key):
                setattr(self.config, key, val)

        # Save to file
        try:
            self.config.save_yaml("config.yaml")
        except Exception as e:
            print(f"[Settings] Failed to save config: {e}")

        self.settings_changed.emit(changes)
        self.close()

