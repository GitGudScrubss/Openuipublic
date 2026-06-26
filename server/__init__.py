# server package

"""
OpenUI Server — FastAPI-based with session management, connections, and tier enforcement.

Modules:
  main.py: FastAPI application entry point
  session.py: Session management (Redis + database)
  connections.py: Database connection pool
  tiers.py: TierGuard class for subscription tier enforcement
  queue.py: Priority queue with tier-based prioritization
  stripe_webhook.py: Stripe webhook handler for subscription updates
"""

try:
    from .tiers import TierGuard, TierId, PermissionError, TIERS
    from .queue import PriorityQueue, Task, TaskPriority
    __all__ = [
        "TierGuard",
        "TierId",
        "PermissionError",
        "TIERS",
        "PriorityQueue",
        "Task",
        "TaskPriority"
    ]
except ImportError:
    # Tier modules may not be imported in all contexts
    pass
