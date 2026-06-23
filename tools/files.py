"""
File operation tools - Read, write, list files.
"""

import os
import glob as globmod
from typing import Dict, Any

from tools.base import BaseTool
from core.helpers import truncate, format_tool_result, ensure_dir


class ReadFileTool(BaseTool):
    """Read file contents."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "read_file"

    @property
    def description(self) -> str:
        return "Read the contents of a file."

    def execute(self, args: Dict[str, Any]) -> str:
        path = args.get("path", "").strip()
        encoding = args.get("encoding", "utf-8")

        if not path:
            return "ERROR: No file path provided."

        # Resolve to absolute path
        path = os.path.abspath(path)

        if not os.path.isfile(path):
            return f"ERROR: File not found: {path}"

        # Check file size (don't read huge files)
        file_size = os.path.getsize(path)
        max_size = 500_000  # 500KB
        if file_size > max_size:
            return f"ERROR: File too large ({file_size // 1024}KB). Max: {max_size // 1024}KB."

        try:
            with open(path, "r", encoding=encoding, errors="replace") as f:
                content = f.read()

            # Count lines and truncate if needed
            lines = content.split("\n")
            if len(lines) > 500:
                content = "\n".join(lines[:250]) + "\n\n... (showing first 250 of {len(lines)} lines)"
                content += "\n... (showing last 50 lines)\n" + "\n".join(lines[-50:])

            return format_tool_result(
                self.name,
                f"File: {path} ({file_size} bytes, {len(lines)} lines)\n\n{truncate(content, 8000)}"
            )

        except Exception as e:
            return format_tool_result(self.name, f"Failed to read file: {e}", success=False)


class WriteFileTool(BaseTool):
    """Write content to a file."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "write_file"

    @property
    def description(self) -> str:
        return "Write content to a file. Creates parent dirs automatically."

    def execute(self, args: Dict[str, Any]) -> str:
        path = args.get("path", "").strip()
        content = args.get("content", "")
        encoding = args.get("encoding", "utf-8")

        if not path:
            return "ERROR: No file path provided."

        path = os.path.abspath(path)

        try:
            # Create parent directories
            parent = os.path.dirname(path)
            if parent:
                ensure_dir(parent)

            with open(path, "w", encoding=encoding) as f:
                f.write(content)

            chars = len(content)
            lines = content.count("\n") + 1
            return format_tool_result(self.name, f"Written to {path} ({chars} chars, {lines} lines)")

        except Exception as e:
            return format_tool_result(self.name, f"Failed to write file: {e}", success=False)


class ListFilesTool(BaseTool):
    """List files in a directory."""

    def __init__(self, config):
        self.config = config

    @property
    def name(self) -> str:
        return "list_files"

    @property
    def description(self) -> str:
        return "List files and directories."

    def execute(self, args: Dict[str, Any]) -> str:
        path = args.get("path", ".").strip()
        pattern = args.get("pattern")

        path = os.path.abspath(path)

        if not os.path.isdir(path):
            return f"ERROR: Directory not found: {path}"

        try:
            if pattern:
                # Use glob pattern
                search_path = os.path.join(path, pattern)
                matches = sorted(globmod.glob(search_path))
                items = [os.path.basename(m) for m in matches[:100]]
            else:
                # List directory contents
                items = sorted(os.listdir(path))
                # Add type indicators
                items = [
                    f"[DIR]  {name}" if os.path.isdir(os.path.join(path, name))
                    else f"[FILE] {name}"
                    for name in items
                ]

            if not items:
                return format_tool_result(self.name, "Directory is empty.")

            result = f"Contents of {path} ({len(items)} items):\n"
            result += "\n".join(items[:100])
            if len(items) > 100:
                result += f"\n... and {len(items) - 100} more"

            return format_tool_result(self.name, result)

        except PermissionError:
            return format_tool_result(self.name, f"Permission denied: {path}", success=False)
        except Exception as e:
            return format_tool_result(self.name, f"Failed to list: {e}", success=False)
