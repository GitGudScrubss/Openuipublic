"""
Task Planner — Breaks high-level user goals into executable step sequences.

When a user says "book a flight to Delhi" or "schedule a meeting with John",
the planner decomposes this into concrete, ordered steps the agent can execute:
  1. Open browser
  2. Navigate to booking site
  3. Fill departure city
  4. Fill arrival city
  5. Select date
  ... etc.

The planner uses the LLM itself to generate plans, then the TaskExecutor runs them.
"""

import json
import time
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, field
from enum import Enum


class TaskStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"
    CANCELLED = "cancelled"
    WAITING_USER = "waiting_user"  # Needs user confirmation (e.g., payment)


@dataclass
class TaskStep:
    """A single step in a task plan."""
    id: int
    description: str                         # Human-readable: "Click the 'New Meeting' button"
    tool_name: Optional[str] = None          # e.g., "mouse_click", "type_text"
    tool_args: Optional[Dict] = None         # e.g., {"x": 500, "y": 300}
    expected_result: str = ""                 # What should happen: "Calendar new event dialog opens"
    requires_vision: bool = True             # Should we screenshot after this step?
    requires_confirmation: bool = False       # Needs user OK before executing (safety)
    status: TaskStatus = TaskStatus.PENDING
    result: str = ""                         # Actual result after execution
    error: str = ""                          # Error message if failed
    retry_count: int = 0
    max_retries: int = 2
    timestamp: float = 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "description": self.description,
            "tool_name": self.tool_name,
            "tool_args": self.tool_args,
            "expected_result": self.expected_result,
            "status": self.status.value,
            "result": self.result,
            "error": self.error,
        }


@dataclass
class TaskPlan:
    """A complete plan for achieving a user's goal."""
    goal: str                                # Original user request
    steps: List[TaskStep] = field(default_factory=list)
    status: TaskStatus = TaskStatus.PENDING
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    summary: str = ""                        # Final summary after completion
    current_step_index: int = 0

    @property
    def current_step(self) -> Optional[TaskStep]:
        if 0 <= self.current_step_index < len(self.steps):
            return self.steps[self.current_step_index]
        return None

    @property
    def progress(self) -> str:
        completed = sum(1 for s in self.steps if s.status == TaskStatus.COMPLETED)
        total = len(self.steps)
        return f"{completed}/{total} steps"

    @property
    def is_complete(self) -> bool:
        return all(s.status == TaskStatus.COMPLETED for s in self.steps)

    @property
    def has_failed(self) -> bool:
        return any(s.status == TaskStatus.FAILED and s.retry_count >= s.max_retries for s in self.steps)

    def to_dict(self) -> dict:
        return {
            "goal": self.goal,
            "status": self.status.value,
            "progress": self.progress,
            "steps": [s.to_dict() for s in self.steps],
        }


# Prompt template for the LLM to generate a plan
PLANNING_PROMPT = """You are a task planner for an AI agent that controls a computer.
The user wants to accomplish the following goal:

GOAL: {goal}

CURRENT SCREEN STATE:
{screen_state}

PLATFORM: {platform}

You must break this goal into a sequence of concrete, actionable steps.
Each step should use one of these available tools:
- execute_terminal: Run a shell command
- capture_screen: Take a screenshot
- read_screen_text: OCR the screen
- mouse_click: Click at coordinates (x, y)
- mouse_scroll: Scroll up/down
- mouse_drag: Drag from one point to another
- type_text: Type text at cursor position
- press_key: Press a key or hotkey (e.g., "enter", "ctrl+c")
- open_browser: Open a URL
- read_file: Read a file
- write_file: Write to a file
- list_files: List directory contents
- join_meeting: Join a video meeting
- describe_screen: Get AI description of current screen

For each step, specify:
- description: What this step does (human readable)
- tool_name: Which tool to use (or null if it's a "check screen" step)
- tool_args: Arguments for the tool (as JSON object)
- expected_result: What should happen after this step
- requires_confirmation: true if this involves money, deletion, or irreversible actions

IMPORTANT RULES:
1. Always start by capturing/reading the screen to understand the current state
2. After any navigation or click, capture the screen to verify the result
3. Be specific with coordinates — if you don't know them, add a "capture_screen" step first
4. For web tasks, prefer opening URLs directly when possible
5. For meeting tasks, use the join_meeting tool
6. Mark financial transactions and destructive actions as requires_confirmation=true
7. Keep steps atomic — one action per step

Respond with a JSON array of steps. Example:
[
  {{"description": "Capture current screen state", "tool_name": "capture_screen", "tool_args": {{}}, "expected_result": "Screenshot of current desktop", "requires_confirmation": false}},
  {{"description": "Open Google Calendar", "tool_name": "open_browser", "tool_args": {{"url": "https://calendar.google.com"}}, "expected_result": "Google Calendar loads in browser", "requires_confirmation": false}}
]

Return ONLY the JSON array, no other text.
"""


class TaskPlanner:
    """Uses the LLM to break user goals into executable task plans."""

    def __init__(self, config, router):
        """
        Args:
            config: OpenUI Config object
            router: ModelRouter for LLM calls
        """
        self.config = config
        self.router = router

    def create_plan(self, goal: str, screen_state: str = "", platform: str = "windows") -> TaskPlan:
        """Generate a task plan for a user goal.

        Args:
            goal: The user's high-level request
            screen_state: Current screen description from VisionLoop
            platform: OS platform

        Returns:
            TaskPlan with steps
        """
        prompt = PLANNING_PROMPT.format(
            goal=goal,
            screen_state=screen_state or "No screen state available — capture first.",
            platform=platform,
        )

        messages = [
            {"role": "system", "content": "You are a precise task planner. Respond only with valid JSON arrays."},
            {"role": "user", "content": prompt},
        ]

        response = self.router.chat(
            messages=messages,
            temperature=0.1,
            max_tokens=4096,
        )

        # Parse the plan
        plan = TaskPlan(goal=goal)

        try:
            # Extract JSON from response (handle markdown code blocks)
            content = response.content.strip()
            if content.startswith("```"):
                # Remove markdown code block
                lines = content.split("\n")
                content = "\n".join(lines[1:-1])

            steps_data = json.loads(content)

            for i, step_data in enumerate(steps_data):
                step = TaskStep(
                    id=i,
                    description=step_data.get("description", f"Step {i}"),
                    tool_name=step_data.get("tool_name"),
                    tool_args=step_data.get("tool_args", {}),
                    expected_result=step_data.get("expected_result", ""),
                    requires_confirmation=step_data.get("requires_confirmation", False),
                    requires_vision=step_data.get("tool_name") in (
                        "mouse_click", "type_text", "press_key", "mouse_scroll",
                        "open_browser", "join_meeting",
                    ),
                )
                plan.steps.append(step)

            print(f"[Planner] Created plan with {len(plan.steps)} steps for: {goal[:80]}")

        except json.JSONDecodeError as e:
            print(f"[Planner] Failed to parse plan JSON: {e}")
            print(f"[Planner] Raw response: {response.content[:500]}")
            # Fallback: create a basic plan
            plan.steps = [
                TaskStep(id=0, description="Capture screen to understand current state",
                         tool_name="capture_screen", tool_args={}, expected_result="Screenshot captured"),
                TaskStep(id=1, description=f"Attempt goal: {goal}",
                         tool_name=None, tool_args={}, expected_result="Goal accomplished"),
            ]

        return plan

    def replan_step(self, plan: TaskPlan, failed_step: TaskStep, screen_state: str) -> List[TaskStep]:
        """Generate alternative steps when a step fails.

        Args:
            plan: The current plan
            failed_step: The step that failed
            screen_state: Current screen state

        Returns:
            List of replacement steps
        """
        prompt = f"""A step in a task plan failed. Generate alternative steps to recover.

ORIGINAL GOAL: {plan.goal}

FAILED STEP: {failed_step.description}
ERROR: {failed_step.error}

CURRENT SCREEN STATE: {screen_state}

Steps completed so far:
{json.dumps([s.to_dict() for s in plan.steps[:failed_step.id]], indent=2)}

Generate 1-3 alternative steps to recover and continue toward the goal.
Respond with a JSON array of step objects (same format as before).
Return ONLY the JSON array.
"""
        messages = [
            {"role": "system", "content": "You are a precise task planner. Respond only with valid JSON arrays."},
            {"role": "user", "content": prompt},
        ]

        response = self.router.chat(messages=messages, temperature=0.2, max_tokens=2048)

        try:
            content = response.content.strip()
            if content.startswith("```"):
                lines = content.split("\n")
                content = "\n".join(lines[1:-1])

            steps_data = json.loads(content)
            new_steps = []
            for i, sd in enumerate(steps_data):
                step = TaskStep(
                    id=failed_step.id + i,
                    description=sd.get("description", f"Recovery step {i}"),
                    tool_name=sd.get("tool_name"),
                    tool_args=sd.get("tool_args", {}),
                    expected_result=sd.get("expected_result", ""),
                    requires_confirmation=sd.get("requires_confirmation", False),
                )
                new_steps.append(step)
            return new_steps

        except Exception as e:
            print(f"[Planner] Failed to generate recovery plan: {e}")
            return []
