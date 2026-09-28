# `test_server.py` — Test Suite

What this file does: validates the corresponding module via `pytest`.

## How to run
```bash
python3 -m pytest tests/test_server.py -v
```

## Coverage
- Goal lifecycle, status transitions, serialization
- Tracker CRUD, progress calculation, blockers
- Checkpoint create/rollback/delete
- Persistence SQLite roundtrip
- Reporter Markdown/JSON output
- Executor dry-run and real command execution
- Server MCP tool integration (all 8 tools)

## Known caveats
- Server tests reset global state via a `tmp_path` fixture to avoid DB conflicts.
