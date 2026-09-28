# SIN-Code-Goal-Mode-Skill

MCP skill for goal tracking with checkpoints, rollback, and progress reports.

## Quick Start

```bash
git clone https://github.com/OpenSIN-Code/SIN-Code-Goal-Mode-Skill.git
cd SIN-Code-Goal-Mode-Skill
python3 -m pytest tests/ -v
```

## MCP Tools

| Tool              | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `goal_start`      | Start a new goal (title, description, subtasks)      |
| `goal_status`     | Show current status (progress, blockers, next steps) |
| `goal_list`       | List all active/completed goals                      |
| `goal_complete`   | Mark a goal as complete                              |
| `goal_checkpoint` | Create a checkpoint snapshot                         |
| `goal_rollback`   | Rollback to last checkpoint                          |
| `goal_subtask`    | Add/update/remove subtasks                           |
| `goal_report`     | Generate a progress report (Markdown/JSON)           |

## CLI Scripts

```bash
./scripts/goal-start.sh -t "My Goal" -d "description" -s '[{"title":"Sub1"}]'
./scripts/goal-status.sh -g <goal_id>
./scripts/goal-list.sh -f active
./scripts/goal-complete.sh -g <goal_id>
./scripts/goal-checkpoint.sh -g <goal_id>
./scripts/goal-rollback.sh -g <goal_id>
./scripts/goal-report.sh -g <goal_id> -f markdown
```

## Architecture

```
MCP Clients (Trayambak / Trayambak / Cursor)
    ↓ stdio
FastMCP Server (sin_goal_mode.server)
    ↓ SQLite
Persistence (sin_goal_mode.db)
    ↓ in-memory
GoalTracker + Checkpointer + Reporter + Executor
```

## Project Structure

```
├── src/sin_goal_mode/
│   ├── goals.py          # Goal/Subtask dataclasses
│   ├── tracker.py        # Progress tracking
│   ├── checkpointer.py   # Snapshots & rollback
│   ├── reporter.py       # Markdown reports
│   ├── persistence.py    # SQLite storage
│   ├── executor.py       # sin-* tool execution
│   └── server.py         # FastMCP server (8 tools)
├── tests/
│   ├── test_goals.py
│   ├── test_tracker.py
│   ├── test_checkpointer.py
│   ├── test_reporter.py
│   ├── test_persistence.py
│   ├── test_executor.py
│   └── test_server.py
├── scripts/
│   └── goal-*.sh         # Bash CLI wrappers
└── .github/workflows/
    └── ceo-audit.yml     # SOTA 47-gate audit
```

## Tests

118 tests covering:

- Goal lifecycle (start → checkpoint → complete)
- Subtask management (add/remove/complete/block)
- Checkpoint/rollback
- Progress calculation
- SQLite persistence
- Error handling
- MCP tool integration

```bash
python3 -m pytest tests/ -v
```

## CoDocs

Every code file has a `.doc.md` companion. See `src/sin_goal_mode/*.doc.md` and `tests/*.doc.md`.

## License

MIT — OpenSIN-Code
