# `__init__.py` — Package Initialization

What this file does: exports the public API of `sin_goal_mode`.

## Files that import this
- `tests/test_*.py` (via `from sin_goal_mode import ...`)
- `scripts/*.sh` (via `python3 -c "from sin_goal_mode.server import ..."`)
- `src/sin_goal_mode/server.py` (imports internal modules)

## Exports
- `Goal`, `GoalStatus`, `Subtask`, `SubtaskStatus` — dataclasses
- `GoalTracker` — progress tracking
- `Checkpoint`, `Checkpointer` — snapshot management
- `Reporter` — Markdown reports
- `Persistence` — SQLite storage
- `Executor` — subtask execution

## Usage
```python
from sin_goal_mode import Goal, GoalTracker
```

## Known caveats
- No heavy imports here to keep startup fast.
