"""In-process registry for running agent turns.

Holds per-run SSE event queues, cancellation flags, approval waiters, and
background task handles. Redis is intentionally not required: everything is
in-process, which is fine for a self-hosted single-instance deployment.
"""
from __future__ import annotations

import asyncio
from typing import Any

# run_id -> asyncio.Queue of {"type": str, "data": dict}
event_buses: dict[str, asyncio.Queue] = {}
# run_id -> set when the user cancels the run
cancel_events: dict[str, asyncio.Event] = {}
# approval_id -> asyncio.Event the agent loop waits on
approval_events: dict[str, asyncio.Event] = {}
# approval_id -> bool outcome set by the approve/deny endpoints
approval_outcomes: dict[str, bool] = {}
# run_id -> asyncio.Task for the running agent loop
background_tasks: dict[str, asyncio.Task] = {}


def get_bus(run_id: str) -> asyncio.Queue:
    bus = event_buses.get(run_id)
    if bus is None:
        bus = asyncio.Queue()
        event_buses[run_id] = bus
    return bus


async def emit(run_id: str, event_type: str, data: dict[str, Any] | None = None) -> None:
    await get_bus(run_id).put({"type": event_type, "data": data or {}})


def request_cancel(run_id: str) -> bool:
    ev = cancel_events.get(run_id)
    if ev is None:
        return False
    ev.set()
    return True


def is_cancelled(run_id: str) -> bool:
    ev = cancel_events.get(run_id)
    return ev.is_set() if ev else False


def register_run(run_id: str) -> None:
    get_bus(run_id)
    cancel_events[run_id] = asyncio.Event()


def track_task(run_id: str, task: asyncio.Task) -> None:
    background_tasks[run_id] = task
    task.add_done_callback(lambda t: background_tasks.pop(run_id, None))


def cleanup_run(run_id: str) -> None:
    event_buses.pop(run_id, None)
    cancel_events.pop(run_id, None)
