# Purpose: FastMCP server exposing goal-mode tools.
# Docs: server.doc.md

import json
import sys
import uuid
from typing import Any, Dict, List, Optional

# FastMCP import with fallback for environments where mcp is not installed
try:
    from mcp.server.fastmcp import FastMCP
except Exception as exc:
    class FastMCP:
        def __init__(self, name: str):
            self.name = name
        def tool(self, fn=None):
            return fn

from .goals import Goal, GoalStatus, Subtask, SubtaskStatus
from .tracker import GoalTracker
from .checkpointer import Checkpointer
from .reporter import Reporter
from .persistence import Persistence
from .executor import Executor

# Global state (singleton per process)
_PERSISTENCE: Optional[Persistence] = None
_TRACKER: Optional[GoalTracker] = None
_CHECKPOINTER: Optional[Checkpointer] = None
_REPORTER: Optional[Reporter] = None
_EXECUTOR: Optional[Executor] = None


def _init_state(db_path: str = "sin_goal_mode.db") -> None:
    """Initialize global state (singleton)."""
    global _PERSISTENCE, _TRACKER, _CHECKPOINTER, _REPORTER, _EXECUTOR
    if _PERSISTENCE is None:
        _PERSISTENCE = Persistence(db_path)
        _TRACKER = GoalTracker(_PERSISTENCE.load_all_goals())
        _CHECKPOINTER = Checkpointer(_PERSISTENCE)
        _CHECKPOINTER.load_from_storage(_PERSISTENCE.load_all_checkpoints())
        _REPORTER = Reporter(_TRACKER.list_all())
        _EXECUTOR = Executor(dry_run=True)


def _save(goal: Goal) -> None:
    """Persist a goal and refresh reporter state."""
    _PERSISTENCE.save_goal(goal)
    _REPORTER.set_goals(_TRACKER.list_all())


# ── Tool functions ──────────────────────────────────────

def goal_start(title: str, description: str = "", subtasks: str = "") -> str:
    """Start a new goal with title, optional description, and optional subtasks (JSON list)."""
    goal_id = str(uuid.uuid4())
    goal = Goal(id=goal_id, title=title, description=description)
    goal.mark_active()
    if subtasks:
        try:
            parsed = json.loads(subtasks)
            for item in parsed:
                if isinstance(item, dict):
                    st = Subtask(
                        id=item.get("id", str(uuid.uuid4())),
                        title=item.get("title", "Unnamed subtask"),
                        description=item.get("description", ""),
                    )
                else:
                    st = Subtask(id=str(uuid.uuid4()), title=str(item))
                goal.add_subtask(st)
        except Exception:
            goal.add_subtask(Subtask(id=str(uuid.uuid4()), title=subtasks))
    _TRACKER.add_goal(goal)
    _save(goal)
    return json.dumps({
        "goal_id": goal.id,
        "title": goal.title,
        "status": goal.status.value,
        "subtasks": len(goal.subtasks),
    }, indent=2)


def goal_status(goal_id: str) -> str:
    """Show current goal status: progress, blockers, and next steps."""
    goal = _TRACKER.get_goal(goal_id)
    if not goal:
        return json.dumps({"error": "Goal not found"}, indent=2)
    status = _TRACKER.get_status(goal_id)
    blockers = _TRACKER.get_blockers(goal_id)
    next_steps = [st.title for st in goal.subtasks if st.status == SubtaskStatus.PENDING]
    return json.dumps({
        "goal_id": goal.id,
        "title": goal.title,
        "status": status,
        "progress_pct": goal.progress_pct(),
        "blockers": blockers,
        "next_steps": next_steps,
        "updated_at": goal.updated_at,
    }, indent=2)


def goal_list(filter_status: str = "") -> str:
    """List all goals, optionally filtered by status (active, completed, pending, failed)."""
    if filter_status:
        goals = [g for g in _TRACKER.list_all() if g.status.value == filter_status]
    else:
        goals = _TRACKER.list_all()
    payload = []
    for g in goals:
        payload.append({
            "id": g.id,
            "title": g.title,
            "status": g.status.value,
            "progress_pct": g.progress_pct(),
            "subtasks": len(g.subtasks),
            "updated_at": g.updated_at,
        })
    return json.dumps({"goals": payload, "count": len(payload)}, indent=2)


def goal_complete(goal_id: str) -> str:
    """Mark a goal as complete."""
    success = _TRACKER.complete_goal(goal_id)
    if not success:
        return json.dumps({"error": "Goal not found or not completable"}, indent=2)
    goal = _TRACKER.get_goal(goal_id)
    _save(goal)
    return json.dumps({
        "goal_id": goal.id,
        "title": goal.title,
        "status": goal.status.value,
        "completed_at": goal.completed_at,
    }, indent=2)


def goal_checkpoint(goal_id: str) -> str:
    """Create a checkpoint (snapshot) of the current goal state."""
    goal = _TRACKER.get_goal(goal_id)
    if not goal:
        return json.dumps({"error": "Goal not found"}, indent=2)
    cp_id = _CHECKPOINTER.create_checkpoint(goal)
    goal.add_checkpoint(cp_id)
    _save(goal)
    return json.dumps({
        "goal_id": goal.id,
        "checkpoint_id": cp_id,
        "checkpoint_count": len(goal.checkpoints),
    }, indent=2)


def goal_rollback(goal_id: str, checkpoint_id: str = "") -> str:
    """Rollback a goal to the last checkpoint (or a given checkpoint_id)."""
    goal = _TRACKER.get_goal(goal_id)
    if not goal:
        return json.dumps({"error": "Goal not found"}, indent=2)
    restored = _CHECKPOINTER.rollback(goal_id, checkpoint_id or None)
    if not restored:
        return json.dumps({"error": "No checkpoint found for rollback"}, indent=2)
    for i, g in enumerate(_TRACKER._goals):
        if g.id == goal_id:
            _TRACKER._goals[i] = restored
            break
    _save(restored)
    return json.dumps({
        "goal_id": restored.id,
        "title": restored.title,
        "status": restored.status.value,
        "checkpoints": len(restored.checkpoints),
        "restored_from": checkpoint_id or "latest",
    }, indent=2)


def goal_subtask(goal_id: str, action: str, subtask_id: str = "", title: str = "", description: str = "") -> str:
    """Add, update, or remove a subtask.
    action must be one of: add, remove, complete, block.
    """
    goal = _TRACKER.get_goal(goal_id)
    if not goal:
        return json.dumps({"error": "Goal not found"}, indent=2)
    if action == "add":
        st = Subtask(id=subtask_id or str(uuid.uuid4()), title=title, description=description)
        _TRACKER.add_subtask(goal_id, st)
        _save(goal)
        return json.dumps({"subtask_id": st.id, "action": "added", "goal_id": goal_id}, indent=2)
    elif action == "remove":
        success = _TRACKER.remove_subtask(goal_id, subtask_id)
        _save(goal)
        return json.dumps({"subtask_id": subtask_id, "action": "removed" if success else "not_found", "goal_id": goal_id}, indent=2)
    elif action == "complete":
        success = _TRACKER.complete_subtask(goal_id, subtask_id)
        _save(goal)
        return json.dumps({"subtask_id": subtask_id, "action": "completed" if success else "not_found", "goal_id": goal_id}, indent=2)
    elif action == "block":
        success = _TRACKER.block_subtask(goal_id, subtask_id, description)
        _save(goal)
        return json.dumps({"subtask_id": subtask_id, "action": "blocked" if success else "not_found", "goal_id": goal_id}, indent=2)
    else:
        return json.dumps({"error": f"Unknown action: {action}"}, indent=2)


def goal_report(goal_id: str = "", format: str = "markdown") -> str:
    """Generate a progress report for one or all goals."""
    report = _REPORTER.generate_report(goal_id or None)
    if format == "json":
        goals = _TRACKER.list_all() if not goal_id else [_TRACKER.get_goal(goal_id)]
        goals = [g for g in goals if g]
        payload = {
            "goals": [g.to_dict() for g in goals],
            "summary": _REPORTER.generate_summary(),
        }
        return json.dumps(payload, indent=2)
    return report


# Tool registry for testing and programmatic access
TOOLS: Dict[str, Any] = {
    "goal_start": goal_start,
    "goal_status": goal_status,
    "goal_list": goal_list,
    "goal_complete": goal_complete,
    "goal_checkpoint": goal_checkpoint,
    "goal_rollback": goal_rollback,
    "goal_subtask": goal_subtask,
    "goal_report": goal_report,
}


def _get_mcp() -> FastMCP:
    """Return the initialized FastMCP application with registered tools."""
    _init_state()
    mcp = FastMCP("sin_goal_mode")
    # fastmcp 3.x: tools are registered via add_tool, not mcp.tool(fn)
    if hasattr(mcp, "add_tool"):
        for name, tool_fn in TOOLS.items():
            mcp.add_tool(name=name, description=(tool_fn.__doc__ or "").strip(), fn=tool_fn)
    else:
        # Fallback for fastmcp 0.x/1.x/2.x
        for tool_fn in TOOLS.values():
            mcp.tool(tool_fn)
    return mcp


def main() -> None:
    """Run the MCP server over stdio."""
    _init_state()
    mcp = _get_mcp()
    if hasattr(mcp, "run"):
        mcp.run()
    else:
        print("FastMCP is not available; running in shim mode.", file=sys.stderr)


if __name__ == "__main__":
    main()
