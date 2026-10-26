# Shrijan - Second Mistake Tracker

This file is regenerated automatically by `nemo/1-errors/mistake.py` whenever the same `error_class` + `error_name` recurs within the 24-hour sliding window.

When a mistake is flagged as a "2nd mistake", the penalty engine (`PENALTY.py`) multiplies the base penalty by 2. If it recurs a **third** time, the user is asked to choose between:

1. **Demote** — assistant's points balance is reduced by 50% and the assistant is restricted to "easy" tasks only for the next 24h.
2. **Reset** — wipe the session and start over with a fresh points balance.
3. **Ignore** — accept the penalty and continue (the next recurrence is treated as critical).

The choices are persisted to `6-u/HISTORY.MD` so the user can audit past escalations.

## Schema (auto-generated rows)

```
## TIMESTAMP — ERROR_NAME
- class: `error_class`
- penalty: **N** points
- description: short description
```
