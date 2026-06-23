"""
Meeting Tool — Join, attend, and participate in video meetings.

Supports Google Meet, Zoom, and Microsoft Teams.
The agent can:
- Join meetings via URL
- Listen to meeting audio (via system audio capture)
- Speak on behalf of the user (via TTS)
- Take real-time notes
- Summarize the meeting afterward
"""

import time
import threading
import webbrowser
from typing import Dict, Any, Optional, Callable
from dataclasses import dataclass, field

from tools.base import BaseTool
from core.helpers import format_tool_result


@dataclass
class MeetingSession:
    """Active meeting session state."""
    meeting_url: str = ""
    platform: str = ""          # "google_meet" | "zoom" | "teams"
    joined_at: float = 0.0
    is_active: bool = False
    transcript: list = field(default_factory=list)  # List of {"speaker": ..., "text": ..., "time": ...}
    notes: list = field(default_factory=list)
    action_items: list = field(default_factory=list)
    participants: list = field(default_factory=list)


def detect_meeting_platform(url: str) -> str:
    """Detect which meeting platform a URL belongs to."""
    url_lower = url.lower()
    if "meet.google.com" in url_lower:
        return "google_meet"
    elif "zoom.us" in url_lower or "zoom.com" in url_lower:
        return "zoom"
    elif "teams.microsoft.com" in url_lower or "teams.live.com" in url_lower:
        return "teams"
    else:
        return "unknown"


class JoinMeetingTool(BaseTool):
    """Join a video meeting and start listening/transcribing."""

    def __init__(self, config, meeting_manager=None):
        self.config = config
        self.meeting_manager = meeting_manager

    @property
    def name(self) -> str:
        return "join_meeting"

    @property
    def description(self) -> str:
        return (
            "Join a video meeting (Google Meet, Zoom, Teams) by URL. "
            "Opens the meeting in browser and starts listening/transcribing."
        )

    def execute(self, args: Dict[str, Any]) -> str:
        url = args.get("url", "").strip()
        user_name = args.get("display_name", "OpenUI Assistant")
        auto_mute_camera = args.get("mute_camera", True)
        auto_mute_mic = args.get("mute_mic", False)

        if not url:
            return "ERROR: No meeting URL provided."

        # Detect platform
        platform = detect_meeting_platform(url)

        # Open in browser
        try:
            webbrowser.open(url)
        except Exception as e:
            return format_tool_result(self.name, f"Failed to open meeting URL: {e}", success=False)

        # Create meeting session
        session = MeetingSession(
            meeting_url=url,
            platform=platform,
            joined_at=time.time(),
            is_active=True,
        )

        if self.meeting_manager:
            self.meeting_manager.set_active_session(session)

        # Platform-specific join instructions for the agent
        join_instructions = self._get_join_instructions(platform, user_name, auto_mute_camera, auto_mute_mic)

        return format_tool_result(
            self.name,
            f"Meeting opened in browser ({platform}).\n"
            f"URL: {url}\n\n"
            f"NEXT STEPS TO JOIN:\n{join_instructions}\n\n"
            f"Use mouse_click and type_text tools to complete the join process. "
            f"Capture the screen first to see the join dialog."
        )

    def _get_join_instructions(self, platform: str, name: str, mute_cam: bool, mute_mic: bool) -> str:
        """Get platform-specific instructions for joining."""
        if platform == "google_meet":
            steps = [
                "1. Wait for the page to load (2-3 seconds)",
                "2. If prompted, enter your name in the name field",
                f"3. Type your display name: '{name}'",
            ]
            if mute_cam:
                steps.append("4. Click the camera icon to turn off camera (usually bottom-left of preview)")
            if mute_mic:
                steps.append("5. Click the microphone icon to mute")
            steps.append("6. Click 'Ask to join' or 'Join now' button")
            return "\n".join(steps)

        elif platform == "zoom":
            steps = [
                "1. Wait for Zoom to launch (may open desktop app or browser)",
                "2. If browser prompt appears, click 'Open Zoom Meetings' or 'Join from Browser'",
                f"3. Enter display name: '{name}'",
            ]
            if mute_cam:
                steps.append("4. Uncheck 'Turn on my video'")
            if mute_mic:
                steps.append("5. Check 'Don't connect to audio' or mute mic after joining")
            steps.append("6. Click 'Join' or 'Join Meeting'")
            return "\n".join(steps)

        elif platform == "teams":
            steps = [
                "1. Wait for Teams to load in browser",
                "2. Click 'Continue on this browser' if prompted",
                f"3. Enter name: '{name}'",
            ]
            if mute_cam:
                steps.append("4. Toggle camera off")
            if mute_mic:
                steps.append("5. Toggle microphone off")
            steps.append("6. Click 'Join now'")
            return "\n".join(steps)

        return "1. Wait for the meeting to load\n2. Follow the on-screen prompts to join"


class MeetingSpeakTool(BaseTool):
    """Speak in a meeting on behalf of the user."""

    def __init__(self, config, tts=None):
        self.config = config
        self.tts = tts

    @property
    def name(self) -> str:
        return "meeting_speak"

    @property
    def description(self) -> str:
        return "Speak text aloud in the current meeting using text-to-speech."

    def execute(self, args: Dict[str, Any]) -> str:
        text = args.get("text", "").strip()
        if not text:
            return "ERROR: No text to speak."

        if self.tts:
            try:
                self.tts.speak(text, wait=True)
                return format_tool_result(self.name, f"Spoke: '{text[:100]}'")
            except Exception as e:
                return format_tool_result(self.name, f"TTS failed: {e}", success=False)
        else:
            return format_tool_result(
                self.name,
                "TTS not available. The text to speak was: " + text,
                success=False,
            )


class LeaveMeetingTool(BaseTool):
    """Leave the current meeting."""

    def __init__(self, config, meeting_manager=None):
        self.config = config
        self.meeting_manager = meeting_manager

    @property
    def name(self) -> str:
        return "leave_meeting"

    @property
    def description(self) -> str:
        return "Leave the current video meeting and generate a summary."

    def execute(self, args: Dict[str, Any]) -> str:
        generate_summary = args.get("generate_summary", True)

        # The agent should use keyboard/mouse to leave
        # This tool provides the instructions
        return format_tool_result(
            self.name,
            "To leave the meeting:\n"
            "1. Move mouse to the bottom of the meeting window to reveal controls\n"
            "2. Click the red 'Leave' or 'End call' button (usually a red phone icon)\n"
            "3. Confirm if prompted\n\n"
            "Use mouse_click to click the leave button. "
            "After leaving, use the summarize_meeting tool to generate notes."
        )


class MeetingManager:
    """Manages active meeting sessions, transcription, and notes."""

    def __init__(self, config):
        self.config = config
        self._active_session: Optional[MeetingSession] = None
        self._lock = threading.Lock()
        self._listeners: list = []

    def set_active_session(self, session: MeetingSession):
        """Set the current active meeting session."""
        with self._lock:
            self._active_session = session
        print(f"[Meeting] Session started: {session.platform} at {session.meeting_url[:60]}")

    def get_active_session(self) -> Optional[MeetingSession]:
        """Get the current meeting session."""
        with self._lock:
            return self._active_session

    def add_transcript_entry(self, speaker: str, text: str):
        """Add a transcription entry to the current meeting."""
        with self._lock:
            if self._active_session:
                self._active_session.transcript.append({
                    "speaker": speaker,
                    "text": text,
                    "time": time.time(),
                    "relative_time": time.time() - self._active_session.joined_at,
                })

    def add_note(self, note: str):
        """Add a note to the current meeting."""
        with self._lock:
            if self._active_session:
                self._active_session.notes.append({
                    "text": note,
                    "time": time.time(),
                })

    def add_action_item(self, item: str, assignee: str = ""):
        """Add an action item from the meeting."""
        with self._lock:
            if self._active_session:
                self._active_session.action_items.append({
                    "item": item,
                    "assignee": assignee,
                    "time": time.time(),
                })

    def end_session(self) -> Optional[MeetingSession]:
        """End the current meeting session and return it."""
        with self._lock:
            session = self._active_session
            if session:
                session.is_active = False
            self._active_session = None
            return session

    def get_transcript_text(self) -> str:
        """Get the full transcript as formatted text."""
        with self._lock:
            if not self._active_session:
                return "No active meeting."
            lines = []
            for entry in self._active_session.transcript:
                mins = int(entry.get("relative_time", 0)) // 60
                secs = int(entry.get("relative_time", 0)) % 60
                lines.append(f"[{mins:02d}:{secs:02d}] {entry['speaker']}: {entry['text']}")
            return "\n".join(lines) if lines else "No transcript entries yet."
