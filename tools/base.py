"""
Base tool class — all tools inherit from this.
"""

from abc import ABC, abstractmethod
from typing import Dict, Any


class BaseTool(ABC):
    """Abstract base class for all OpenUI tools."""

    @property
    @abstractmethod
    def name(self) -> str:
        """The tool name as referenced in LLM function calls."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Short description of what this tool does."""
        pass

    @abstractmethod
    def execute(self, args: Dict[str, Any]) -> str:
        """Execute the tool with given arguments.

        Args:
            args: Dictionary of arguments from the LLM

        Returns:
            String result to feed back to the LLM
        """
        pass

    def validate_args(self, args: Dict[str, Any]) -> bool:
        """Override to add argument validation. Default: accept all."""
        return True
