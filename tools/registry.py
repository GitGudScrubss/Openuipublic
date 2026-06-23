"""
Tool Registry - Manages all available tools.
"""

from typing import Dict, List, Optional, Type
from tools.base import BaseTool


class ToolRegistry:
    """Registry that holds all tool instances and dispatches calls."""

    def __init__(self):
        self._tools: Dict[str, BaseTool] = {}

    def register(self, tool: BaseTool):
        """Register a tool instance."""
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[BaseTool]:
        """Get a tool by name."""
        return self._tools.get(name)

    def list_names(self) -> List[str]:
        """List all registered tool names."""
        return list(self._tools.keys())

    def list_tools(self) -> List[BaseTool]:
        """List all tool instances."""
        return list(self._tools.values())

    def execute(self, name: str, args: dict) -> str:
        """Execute a tool by name."""
        tool = self.get(name)
        if not tool:
            return f"ERROR: Tool '{name}' not found. Available: {self.list_names()}"
        return tool.execute(args)

    def unregister(self, name: str):
        """Remove a tool by name."""
        if name in self._tools:
            del self._tools[name]


def create_registry(config, meeting_manager=None, tts=None, router=None) -> ToolRegistry:
    """Create and populate the tool registry based on config.

    Args:
        config: OpenUI Config object
        meeting_manager: Optional MeetingManager instance
        tts: Optional TextToSpeech instance
        router: Optional ModelRouter instance

    Returns:
        Populated ToolRegistry
    """
    registry = ToolRegistry()

    if config.tools_terminal:
        from tools.terminal import TerminalTool
        registry.register(TerminalTool(config))

    if config.tools_screen_capture:
        from tools.screen import CaptureScreenTool, ReadScreenTextTool
        registry.register(CaptureScreenTool(config))
        registry.register(ReadScreenTextTool(config))

    if config.tools_mouse_control:
        from tools.mouse import MouseClickTool, MouseScrollTool, MouseDragTool
        registry.register(MouseClickTool(config))
        registry.register(MouseScrollTool(config))
        registry.register(MouseDragTool(config))

    if config.tools_keyboard_control:
        from tools.keyboard import TypeTextTool, PressKeyTool
        registry.register(TypeTextTool(config))
        registry.register(PressKeyTool(config))

    if config.tools_browser:
        from tools.browser import (
            OpenBrowserTool,
            BrowserClickTool,
            BrowserTypeTextTool,
            BrowserExtractTool,
            CloseBrowserTool
        )
        registry.register(OpenBrowserTool(config))
        registry.register(BrowserClickTool(config))
        registry.register(BrowserTypeTextTool(config))
        registry.register(BrowserExtractTool(config))
        registry.register(CloseBrowserTool(config))

    if config.tools_file_ops:
        from tools.files import ReadFileTool, WriteFileTool, ListFilesTool
        registry.register(ReadFileTool(config))
        registry.register(WriteFileTool(config))
        registry.register(ListFilesTool(config))

    # Initialize meeting dependencies if not provided
    if meeting_manager is None:
        from tools.meeting import MeetingManager
        meeting_manager = MeetingManager(config)

    if tts is None:
        try:
            from voice.tts import TextToSpeech
            tts = TextToSpeech(config)
        except Exception:
            pass

    if router is None:
        try:
            from core.router import ModelRouter
            router = ModelRouter(config)
        except Exception:
            pass

    # Register meeting and notes tools
    from tools.meeting import JoinMeetingTool, MeetingSpeakTool, LeaveMeetingTool
    from tools.meeting_notes import MeetingNotesTool

    registry.register(JoinMeetingTool(config, meeting_manager))
    registry.register(MeetingSpeakTool(config, tts))
    registry.register(LeaveMeetingTool(config, meeting_manager))
    registry.register(MeetingNotesTool(config, meeting_manager, router))

    print(f"[Registry] Loaded {len(registry.list_names())} tools: {', '.join(registry.list_names())}")
    return registry
