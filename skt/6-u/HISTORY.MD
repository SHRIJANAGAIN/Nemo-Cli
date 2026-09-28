# SKT AI LABS - Improvement History

This file is the **golden record** of successful task completions. Every time a task is fully successful (no mistakes, user gave positive feedback, eval cycle closed above 0.8 reliability), the assistant appends a row here.

## Schema

```
## TIMESTAMP — task_name
- task_id: t_xxxxxxxx
- task_type: easy | normal | medium | high | critical
- session_id: sess_xxxxxxxx
- summary: one-line description of what was done
- tokens: approximate count
- improvements: number of new improvements recorded
- bonus: points awarded beyond base
```

## Why this matters

`6-u/chk.py` cross-references the assistant's current response against this history to:

- Detect when a similar task has been solved before (faster path, fewer mistakes)
- Spot regressions when a solved task is now failing
- Compute the "experience curve" — tasks done once vs tasks done many times

`6-u/reward.py` reads the streak count (consecutive high-reliability days) to unlock bonus tiers.

## History

<!-- Append successful task completions here. Do not edit by hand. -->
