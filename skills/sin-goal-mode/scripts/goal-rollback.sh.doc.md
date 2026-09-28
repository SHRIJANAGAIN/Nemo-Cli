# `goal-rollback.sh` — Bash CLI Wrapper

What this script does: provides a POSIX-friendly CLI entry point for the corresponding MCP tool.

## Usage
```bash
./goal-rollback.sh -h
```

## Dependencies
- Python 3 (for importing `sin_goal_mode.server`)
- `src/` directory in the working directory

## Known caveats
- Scripts are thin wrappers; all logic lives in the Python server layer.
