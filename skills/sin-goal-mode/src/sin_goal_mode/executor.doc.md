# `executor.py` — Subtask Execution

What this file does: maps subtasks to external `sin-*` CLI tools and executes them.

## Files that import this
- `server.py` — `goal_subtask` tool may trigger execution (future)
- `tests/test_executor.py`

## Tool mapping
| Prefix | Binary |
|--------|--------|
| sin-discover | discover |
| sin-map | map |
| sin-grasp | grasp |
| sin-scout | scout |
| sin-execute | execute |
| sin-harvest | harvest |
| sin-orchestrate | orchestrate |

## Usage
```python
from sin_goal_mode.executor import Executor
e = Executor(dry_run=True)
result = e.execute_subtask(subtask, goal)
```

## Known caveats
- `dry_run=True` logs commands without executing them.
- Unknown subtasks fall back to a non-existent command (will fail in real mode).
