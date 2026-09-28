# `checkpointer.py` — Checkpoint & Rollback

What this file does: creates snapshots of goals and restores them on demand.

## Files that import this
- `server.py` — `goal_checkpoint` and `goal_rollback` tools
- `tests/test_checkpointer.py`

## Usage
```python
from sin_goal_mode.checkpointer import Checkpointer
c = Checkpointer()
cp_id = c.create_checkpoint(goal)
restored = c.rollback(goal.id, cp_id)
```

## Known caveats
- `rollback()` restores the goal snapshot but sets status to `ROLLED_BACK`.
- Checkpoints are stored in memory by default; use `Persistence` for durability.
