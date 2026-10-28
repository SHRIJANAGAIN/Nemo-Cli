# Nemo Code - Improvement Log

Every time the assistant fixes a mistake (see `1-errors/mistake.py mark_fixed`) or the user gives a thumbs-up after a task, a row is appended here. The eval system (`5-eval/eval.py`) reads this file to compute a **reliability score** that feeds into the reward engine (`6-u/reward.py`).

## Schema

```
## TIMESTAMP
- description: what was improved
- related error: `err_id` (optional)
```

## Why this matters

A high improvement rate with low repeat-error rate is the **single best signal** that the assistant is actually learning. The reward engine uses:

```
reliability = improvements / (improvements + repeats)
```

When reliability ≥ 0.8 for 7 consecutive days, the assistant earns a **bonus +5** every time it completes a "high" or "critical" task. When reliability < 0.5, the assistant is restricted to "easy" tasks only.

## Sibling files

- `1-errors/MISTAKES.MD` — the raw mistake log
- `6-u/HISTORY.MD` — successful task history
- `5-eval/EVALS.MD` — evaluation history
- `6-u/reward.py` — applies bonuses based on this log
