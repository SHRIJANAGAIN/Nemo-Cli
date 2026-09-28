# SKT AI LABS - Excluded Points Ledger

Every row in this ledger is a **deduction** — a moment where the assistant lost points for a mistake, a hallucination, a user correction, or a repeated error. Rows are immutable once written. The canonical machine-readable form lives in `excludedpoints.jsonl`; this Markdown is regenerated for human review.

## Schema

| Column           | Type     | Description                                                                       |
| ---------------- | -------- | --------------------------------------------------------------------------------- |
| task_id          | string   | Unique task identifier (e.g. `t_a3f9b1c2`)                                        |
| task_name        | string   | Short name of the task (e.g. "fix-import", "build-runtime")                       |
| task_description | string   | One-line description of what was being attempted                                  |
| task_type        | enum     | `easy` / `normal` / `medium` / `high` / `critical`                                |
| points_reduced   | int      | Number of points deducted (always positive; subtracted from balance)              |
| timestamp        | ISO 8601 | UTC millisecond timestamp when the deduction was recorded                         |
| user_feedback    | string   | What the user said after the mistake (up to 1000 chars)                           |
| user_input       | string   | The full user input that triggered the failure                                    |
| assistant_output | string   | The full assistant output that contained the mistake                              |
| available_points | int      | Running balance after the deduction                                               |
| reason           | string   | Short reason: `repeated`, `hallucination`, `user_correction`, `device`, `timeout` |
| repeated         | bool     | True if this is the same mistake the assistant has made before                    |

## Why excluded points matter

- A high exclusion rate signals that the assistant is **not learning from feedback**.
- Repeated mistakes trigger an automatic 2× penalty (see `1-errors/2nd-mistake.md`).
- The eval system (`5-eval/eval.py`) uses this ledger to compute a **reliability score**.

## Sibling files

- `points.md` — the awards ledger (positive points)
- `1-errors/MISTAKES.MD` — full mistake log with full context
- `1-errors/IMPROVEMENT.MD` — improvements recorded after each fix
- `6-u/HISTORY.MD` — improvement history
- `6-u/reward.py` — adjusts future rewards based on exclusion rate

## Rotation policy

When `excludedpoints.jsonl` exceeds 50 MB, older entries are archived to `excludedpoints-YYYY-MM.jsonl` and removed from the active ledger. The Markdown mirror is regenerated from the active file.

## Privacy

The user_input and assistant_output fields may contain secrets if the user pasted them. The upload subsystem (`10-upload/upload.ts`) redacts common secret patterns before transmitting this file.
