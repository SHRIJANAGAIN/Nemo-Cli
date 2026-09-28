---
description: Treat the request as sustained orchestrated work via Trayambak Flow (deterministic, resumable).
argument-hint: "[the unit of work]"
---

# /deepwork - Sustained Orchestrated Work

`deepwork` is the keyword that turns a request into a sustained, orchestrated
unit of work rather than a one-shot reply. Drop it anywhere in the prompt:

```
deepwork: migrate every call site off the old auth middleware, one subagent per package, then verify the build
```

## How it works

1. Decompose the work into ordered steps: `{id, action, prompt?, tool?, args?}`.
2. Call `trayambak__RunWorkflow` with the JSON workflow. Steps are bounded
   (max 20), validated, and every run is recorded to
   `.trayambak/workflow-runs/<runId>.json`.
3. Resume, don't redo: re-call with `resumeFromRunId`. Steps with identical
   id+content are reused from the record — only edited or new steps re-run.
   An edited step invalidates everything after it (later steps may depend on it).
4. Parallelize inside steps with `trayambak__RunTeam` / `trayambak__Debate`;
   track with `trayambak__TaskCreate` / `trayambak__TaskOutput`.

## Rules

- Keep workflows deterministic: same definition re-run from the same record
  reproduces the same reuse set. No wall-clock or random content in steps.
- Cap 20 steps per run; split bigger efforts into named sequential workflows.
- Report the run id so the user can resume later.
