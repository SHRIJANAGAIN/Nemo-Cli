# `persistence.py` — SQLite Persistence

What this file does: persists goals and checkpoints to SQLite.

## Files that import this
- `server.py` — `_init_state()` creates the persistence layer
- `tests/test_persistence.py`

## Schema
- `goals` table: id, title, description, status, subtasks(JSON), checkpoints(JSON), timestamps, metadata(JSON)
- `checkpoints` table: checkpoint_id, goal_id, snapshot(JSON), created_at

## Usage
```python
from sin_goal_mode.persistence import Persistence
p = Persistence("goals.db")
p.save_goal(goal)
loaded = p.load_goal("g1")
```

## Known caveats
- `subtasks`, `checkpoints`, `metadata` are stored as JSON strings.
