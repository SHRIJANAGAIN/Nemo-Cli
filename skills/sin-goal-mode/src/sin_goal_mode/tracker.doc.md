# `tracker.py` — Goal Tracking & Progress Calculation

What this file does: manages a collection of goals, status transitions, and subtask updates.

## Files that import this
- `server.py` — tracker is the single source of truth for all MCP tools
- `tests/test_tracker.py`

## Important config values & limits
- `list_active()` returns PENDING + ACTIVE goals
- `complete_goal()` only works if status is ACTIVE or PENDING
- `start_goal()` only works if status is PENDING

## Usage
```python
from sin_goal_mode.tracker import GoalTracker
t = GoalTracker()
t.add_goal(Goal(id="g1", title="T"))
t.start_goal("g1")
t.complete_goal("g1")
```

## Known caveats
- `_goals` is a plain list — look-up is O(n). For >1000 goals, consider a dict index.
