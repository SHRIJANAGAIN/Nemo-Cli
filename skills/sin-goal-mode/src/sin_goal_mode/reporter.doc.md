# `reporter.py` — Markdown Report Generation

What this file does: generates human-readable progress reports for one or all goals.

## Files that import this
- `server.py` — `goal_report` tool
- `tests/test_reporter.py`

## Usage
```python
from sin_goal_mode.reporter import Reporter
r = Reporter(goals)
print(r.generate_report("g1"))  # single goal
print(r.generate_report())      # all goals
```

## Known caveats
- Report format is Markdown with `#` headers. JSON format is available via server tool.
