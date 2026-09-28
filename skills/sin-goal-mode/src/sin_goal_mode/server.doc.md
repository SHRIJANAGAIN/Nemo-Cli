# `server.py` — FastMCP Server

What this file does: exposes 8 goal-mode tools via the Model Context Protocol (MCP).

## Tools exposed
| Tool | Purpose |
|------|---------|
| `goal_start` | Create a new goal |
| `goal_status` | Show progress, blockers, next steps |
| `goal_list` | List goals (filter by status) |
| `goal_complete` | Mark goal as completed |
| `goal_checkpoint` | Snapshot current state |
| `goal_rollback` | Restore from checkpoint |
| `goal_subtask` | Add/remove/complete/block subtasks |
| `goal_report` | Generate Markdown or JSON report |

## Files that import this
- `scripts/*.sh` — CLI wrappers
- `tests/test_server.py`

## Usage
```python
from sin_goal_mode.server import _init_state, TOOLS
_init_state()
result = TOOLS["goal_start"](title="My Goal")
```

## Known caveats
- Global state is a singleton per process. Tests use a fixture to reset it.
- FastMCP import is optional; a shim is provided for environments without `mcp`.
