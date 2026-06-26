"""
OpenUI Server — Subscription tier enforcement, task queue, and Stripe webhooks.

Modules:
  tiers.py: TierGuard class, tier definitions, permission checking
  stripe_webhook.py: Stripe webhook handler for subscription updates
  queue.py: Priority queue with tier-based prioritization
"""

try:
    from .tiers import TierGuard, TierId, PermissionError, TIERS
    from .queue import PriorityQueue, Task, TaskPriority
except ImportError:
    # Optional: graceful degradation when supabase/redis aren't fully installed
    pass

__all__ = [
    "TierGuard",
    "TierId",
    "PermissionError",
    "TIERS",
    "PriorityQueue",
    "Task",
    "TaskPriority"
]
