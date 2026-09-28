---
description: Trayambak Fleet — list and peek at background subagent sessions in this process.
---

# /fleet - Trayambak Fleet

Live dashboard over this session's background workers. Jobs are in-process:
they do not survive restart, and a fresh process sees an empty fleet. Say so
instead of inventing sessions.

## Usage

- `/fleet` — `trayambak__Fleet` `list`: Working / Done / Needs input groups.
- `/fleet peek <id|name>` — `trayambak__Fleet` `peek`: recent output (last 2KB) without attaching.
- Dispatch: `trayambak__Agent` with `background: true` boots a worker in ~0ms.
- Steer: `trayambak__SendMessage` to a running job (it reads its inbox next turn).
- Track: `trayambak__TaskGet` / `trayambak__TaskOutput` for structured task state.

## Rules

- Never claim cross-process visibility. A separate `trayambak` process has its own fleet.
- Peek is read-only. To redirect a worker, message it; to stop it, cancel via the tasks tool.
- Finished jobs never read new messages — relaunch instead of messaging the dead.
