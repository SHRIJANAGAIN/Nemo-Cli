# `goals.py` — Goal and Subtask Dataclasses

What this file does: defines the core data model for goals and subtasks with status enums.

## Files that import this
- `tracker.py` — manipulates Goal/Subtask objects
- `checkpointer.py` — serializes goals to snapshots
- `reporter.py` — reads goal properties
- `persistence.py` — converts between dicts and DB rows
- `executor.py` — executes subtasks
- `server.py` — creates goals via MCP tools
- `tests/test_goals.py`

## Important config values & limits
- `GoalStatus` enum: PENDING, ACTIVE, COMPLETED, FAILED, ROLLED_BACK
- `SubtaskStatus` enum: PENDING, IN_PROGRESS, COMPLETED, BLOCKED
- `progress_pct()` returns 0.0 for empty subtasks unless status is COMPLETED (then 100.0)

## Why certain decisions were made
- Pure dataclasses with `to_dict()` / `from_dict()` for easy JSON and SQLite serialization
- `created_at` / `updated_at` stored as ISO strings for portability

## Usage
```python
from sin_goal_mode.goals import Goal, Subtask

g = Goal(id="g1", title="Build feature")
g.add_subtask(Subtask(id="s1", title="Design API"))
```

## Known caveats
- `from_dict()` does not validate enum strings — invalid values will raise ValueError
