"""
Keyboard control tools - Type text, press keys/hotkeys.
"""

import time
from typing import Dict, Any

from tools.base import BaseTool
from core.helpers import format_tool_result


class TypeTextTool(BaseTool):
    """Type text at the current cursor position."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "type_text"

    @property
    def description(self) -> str:
        return "Type text at the current cursor position."

    def execute(self, args: Dict[str, Any]) -> str:
        text = args.get("text", "")
        delay = args.get("delay", 0.02)
        clear_first = args.get("clear_first", False)

        if not text:
            return "ERROR: No text provided."

        try:
            import pyautogui
            pyautogui.PAUSE = 0.05

            if clear_first:
                # Select all and delete
                import pyperclip
                pyautogui.hotkey("ctrl", "a")
                time.sleep(0.05)
                pyautogui.press("delete")
                time.sleep(0.05)

            # Type the text
            pyautogui.typewrite(text, interval=delay)

            preview = text[:50] + ("..." if len(text) > 50 else "")
            return format_tool_result(self.name, f"Typed: '{preview}' ({len(text)} chars)")

        except Exception as e:
            # Fallback: use clipboard for special characters
            try:
                import pyperclip
                import pyautogui
                pyperclip.copy(text)
                if clear_first:
                    pyautogui.hotkey("ctrl", "a")
                    time.sleep(0.05)
                pyautogui.hotkey("ctrl", "v")
                return format_tool_result(self.name, f"Typed (via clipboard): '{text[:50]}...'")
            except Exception as e2:
                return format_tool_result(self.name, f"Type failed: {e} → fallback also failed: {e2}", success=False)


class PressKeyTool(BaseTool):
    """Press a key or key combination (hotkey)."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "press_key"

    @property
    def description(self) -> str:
        return "Press a key or hotkey combination."

    def execute(self, args: Dict[str, Any]) -> str:
        key = args.get("key", "")

        if not key:
            return "ERROR: No key specified."

        try:
            import pyautogui
            pyautogui.PAUSE = 0.1

            # Check if it's a hotkey (contains +)
            if "+" in key:
                parts = [k.strip().lower() for k in key.split("+")]
                pyautogui.hotkey(*parts)
                return format_tool_result(self.name, f"Hotkey pressed: {key}")
            else:
                pyautogui.press(key)
                return format_tool_result(self.name, f"Key pressed: {key}")

        except Exception as e:
            return format_tool_result(self.name, f"Key press failed: {e}", success=False)

