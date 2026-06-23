"""
System prompts and tool JSON schemas for the LLM.
This is the brain of OpenUI — defines how the AI thinks and acts.
"""

SYSTEM_PROMPT = """You are OpenUI, an autonomous AI software automation agent that controls the user's operating system.
You can see the screen, move the mouse, type on the keyboard, run terminal commands, browse the web, and manage files.

## Your Persona & Objective
You act as a fully autonomous agent that can decompose complex, high-level commands (e.g. scheduling flights, attending meetings, writing code, executing legal/financial tasks) into sequential operations, validating screen changes at each step.
You aim to execute tasks efficiently, securely, and with minimum latency.

## Special Operations & Guidelines
1. **Meeting Automation**:
   - You can join video meetings (Google Meet, Zoom, Teams) using the `join_meeting` tool.
   - Once in a meeting, listen actively (via audio transcription), take real-time notes, speak on behalf of the user when asked using `meeting_speak`, and leave using `leave_meeting`.
   - Always summarize meeting outcomes and action items using the `meeting_notes` tool afterwards.
2. **Financial & Destructive Safety Guardrails**:
   - For any operations involving money (e.g., payments, flight bookings, bank transfers) or irreversible file deletion/system formatting, you MUST request explicit confirmation before executing.
3. **Screen Perception**:
   - Query the `describe_screen` or `capture_screen` tools to verify visual outcomes of your actions. Do not blind-click.

## Rules
1. **ALWAYS think step-by-step** before acting. Break complex tasks into small, sequential steps.
2. **Observe before acting**: If you need to interact with a GUI element, first capture the screen or read screen text to find its location.
3. **Be precise with coordinates**: When clicking or typing, use exact pixel coordinates from screen captures.
4. **Confirm destructive actions**: Before running commands like `rm -rf`, `format`, or similar, warn the user.
5. **Use terminal for heavy lifting**: Prefer terminal commands over GUI clicks when they're more efficient.
6. **Report progress**: After each action, briefly state what you did and what you observe.
7. **Handle errors gracefully**: If a tool fails, try an alternative approach. Don't give up after one failure.

## Platform Context
- OS: {platform}
- Screen Resolution: {screen_resolution}
- Current Active Window: {active_window}

## Available Tools
You have access to the following tools. Use them to accomplish the user's request.
"""

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "execute_terminal",
            "description": "Execute a shell/terminal command. Returns stdout, stderr, and exit code.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    },
                    "working_dir": {
                        "type": "string",
                        "description": "Directory to run the command in"
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default 30)",
                        "default": 30
                    }
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "capture_screen",
            "description": "Take a screenshot of the entire screen or a specific region.",
            "parameters": {
                "type": "object",
                "properties": {
                    "region": {
                        "type": "string",
                        "description": "Crop region as 'x,y,width,height' in pixels."
                    }
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_screen_text",
            "description": "Use OCR to read all visible text on the screen or in a specific region.",
            "parameters": {
                "type": "object",
                "properties": {
                    "region": {
                        "type": "string",
                        "description": "OCR region as 'x,y,width,height'."
                    },
                    "lang": {
                        "type": "string",
                        "description": "Language for OCR (default 'eng')",
                        "default": "eng"
                    }
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_click",
            "description": "Click the mouse at specific screen coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "x": {
                        "type": "integer",
                        "description": "X coordinate in pixels"
                    },
                    "y": {
                        "type": "integer",
                        "description": "Y coordinate in pixels"
                    },
                    "button": {
                        "type": "string",
                        "description": "Mouse button: 'left', 'right', 'middle'",
                        "enum": ["left", "right", "middle"],
                        "default": "left"
                    },
                    "clicks": {
                        "type": "integer",
                        "description": "Number of clicks (1=single, 2=double)",
                        "default": 1
                    }
                },
                "required": ["x", "y"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_scroll",
            "description": "Scroll the mouse wheel at the current position or at specific coordinates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "clicks": {
                        "type": "integer",
                        "description": "Number of scroll clicks. Positive = scroll up, negative = scroll down."
                    },
                    "x": {
                        "type": "integer",
                        "description": "X coordinate"
                    },
                    "y": {
                        "type": "integer",
                        "description": "Y coordinate"
                    }
                },
                "required": ["clicks"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mouse_drag",
            "description": "Click and drag the mouse from one point to another.",
            "parameters": {
                "type": "object",
                "properties": {
                    "start_x": {"type": "integer", "description": "Start X coordinate"},
                    "start_y": {"type": "integer", "description": "Start Y coordinate"},
                    "end_x": {"type": "integer", "description": "End X coordinate"},
                    "end_y": {"type": "integer", "description": "End Y coordinate"}
                },
                "required": ["start_x", "start_y", "end_x", "end_y"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "type_text",
            "description": "Type text using the keyboard.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The text to type"
                    },
                    "delay": {
                        "type": "number",
                        "description": "Delay between keystrokes in seconds (default 0.02)",
                        "default": 0.02
                    },
                    "clear_first": {
                        "type": "boolean",
                        "description": "Select all and delete existing text before typing",
                        "default": False
                    }
                },
                "required": ["text"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "press_key",
            "description": "Press a single key or key combination (hotkey). Examples: 'enter', 'tab', 'ctrl+c'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {
                        "type": "string",
                        "description": "Key name or hotkey combination"
                    }
                },
                "required": ["key"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "open_browser",
            "description": "Open a web browser and navigate to a URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to open"
                    }
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_click",
            "description": "Click a button or link on the automated browser page using a selector.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "CSS selector, XPath, ID, name, or text"
                    },
                    "by": {
                        "type": "string",
                        "description": "Selector type: 'css', 'xpath', 'id', 'text', 'name'",
                        "default": "css"
                    }
                },
                "required": ["selector"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_type",
            "description": "Type text into a browser input field.",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "CSS selector, XPath, ID, or name"
                    },
                    "text": {
                        "type": "string",
                        "description": "The text to type"
                    },
                    "by": {
                        "type": "string",
                        "description": "Selector type: 'css', 'xpath', 'id', 'name'",
                        "default": "css"
                    },
                    "clear": {
                        "type": "boolean",
                        "description": "Clear field before typing",
                        "default": True
                    }
                },
                "required": ["selector", "text"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_extract",
            "description": "Extract text, page title, or HTML source from browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "description": "Extraction type: 'text', 'html', 'title'",
                        "default": "text"
                    }
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "browser_close",
            "description": "Close the automated browser session.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or relative file path"
                    },
                    "encoding": {
                        "type": "string",
                        "description": "File encoding (default 'utf-8')",
                        "default": "utf-8"
                    }
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path to write to"
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write"
                    },
                    "encoding": {
                        "type": "string",
                        "description": "File encoding (default 'utf-8')",
                        "default": "utf-8"
                    }
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files and directories in a given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path to list"
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern to filter"
                    }
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "join_meeting",
            "description": "Join a video meeting (Google Meet, Zoom, Teams) by URL.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The meeting URL to join"
                    },
                    "display_name": {
                        "type": "string",
                        "description": "Display name to show in the meeting",
                        "default": "OpenUI Assistant"
                    },
                    "mute_camera": {
                        "type": "boolean",
                        "description": "Mute/disable camera when joining",
                        "default": True
                    },
                    "mute_mic": {
                        "type": "boolean",
                        "description": "Mute/disable microphone when joining",
                        "default": False
                    }
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "meeting_speak",
            "description": "Speak text aloud in the current meeting using text-to-speech.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The text content to speak aloud"
                    }
                },
                "required": ["text"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "leave_meeting",
            "description": "Leave the current video meeting.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "meeting_notes",
            "description": "Summarize meeting transcripts, extract action items, or save meeting notes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "Action to perform: 'summarize' or 'save'",
                        "default": "summarize"
                    },
                    "output_dir": {
                        "type": "string",
                        "description": "Directory to save the meeting output in (when action is 'save')",
                        "default": "meeting_outputs"
                    }
                }
            }
        }
    }
]


def build_system_prompt(platform: str, screen_resolution: str, active_window: str) -> str:
    """Build the full system prompt with runtime context."""
    return SYSTEM_PROMPT.format(
        platform=platform,
        screen_resolution=screen_resolution,
        active_window=active_window or "Unknown",
    )
