# sin-goal-mode

Goal tracking skill for Nemo / MCP with checkpoints, rollback, and progress reports.

## What it does

- **goal_start** — Create a new goal with optional subtasks (JSON list)
- **goal_status** — Show progress percentage, blockers, and next pending steps
- **goal_list** — List all goals (filter by status: active, completed, pending, failed)
- **goal_complete** — Mark a goal as done
- **goal_checkpoint** — Snapshot current goal state (for rollback)
- **goal_rollback** — Restore goal from latest checkpoint
- **goal_subtask** — Add/remove/complete/block subtasks
- **goal_report** — Generate Markdown or JSON progress report

## When to use

- Breaking a large task into trackable subtasks
- Creating checkpoints before risky changes
- Rolling back when a goal goes wrong
- Generating progress reports for the user

## Installation

```bash
git clone https://github.com/OpenSIN-Code/SIN-Code-Goal-Mode-Skill.git
```

## Usage via MCP

The server exposes 8 tools. In Nemo or any MCP client:

```json
{
  "mcpServers": {
    "sin-goal-mode": {
      "command": "python3",
      "args": ["-m", "sin_goal_mode.server"]
    }
  }
}
```

## Usage via CLI

```bash
# Start a goal
./scripts/goal-start.sh -t "Refactor auth module" -s '[{"title":"Extract service"}]'

# Check status
./scripts/goal-status.sh -g <goal_id>

# Create checkpoint
./scripts/goal-checkpoint.sh -g <goal_id>

# Rollback if needed
./scripts/goal-rollback.sh -g <goal_id>

# Complete
./scripts/goal-complete.sh -g <goal_id>

# Report
./scripts/goal-report.sh -g <goal_id>
```

## Python API

```python
from sin_goal_mode import Goal, GoalTracker, Checkpointer, Reporter

# Create and track
tracker = GoalTracker()
goal = Goal(id="g1", title="Build API")
tracker.add_goal(goal)
tracker.start_goal("g1")
tracker.add_subtask("g1", Subtask(id="s1", title="Design endpoints"))
tracker.complete_subtask("g1", "s1")

# Checkpoint
cp = Checkpointer()
cp_id = cp.create_checkpoint(goal)

# Rollback
restored = cp.rollback("g1", cp_id)

# Report
r = Reporter(tracker.list_all())
print(r.generate_report("g1"))
```

## Persistence

Goals and checkpoints are stored in `sin_goal_mode.db` (SQLite). The server auto-initializes on first run.

## Testing

```bash
python3 -m pytest tests/ -v
```

118 tests covering lifecycle, subtasks, checkpoints, rollback, persistence, reports, execution, and MCP integration.
