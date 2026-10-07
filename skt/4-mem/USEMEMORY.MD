# SKT AI LABS - User Memory (Active)

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```
### MEM-YYYYMMDD-NNN
- created: 2026-09-03T10:00:00Z
- category: preference | fact | project | person | tool | workflow
- confidence: 0.0-1.0
- source: user | inferred | imported
- last_used: 2026-09-03T10:00:00Z
- use_count: 0
- tags: [comma, separated]

Free-form body — the actual memory.
```

The agent uses `4-mem/memory.ts loadMemory` to inject relevant entries into the system prompt based on the current task context.

## Active entries

<!-- The assistant appends entries below. Do not edit by hand. -->

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:23:07.887Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:33:52.832Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:23:07.887Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:37:47.546Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:23:07.887Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T13:42:54.073Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:23:07.887Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-06T08:42:05.454Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:23:07.887Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:03:28.802Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:23:07.887Z
- use_count: 0
- tags: []

- created: 2026-10-06T10:11:47.662Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:23:07.885Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:23:07.887Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:39:36.292Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:39:36.295Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:40:42.542Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:40:42.545Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T17:52:07.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:52:07.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:52:07.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:52:07.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:52:07.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:52:07.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:52:07.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:52:07.383Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-06T17:53:44.784Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:53:44.784Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:53:44.784Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:53:44.784Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:53:44.784Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

- created: 2026-10-06T17:53:44.784Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T17:53:44.789Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-07T03:27:33.179Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:27:33.179Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:27:33.179Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:27:33.179Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:27:33.179Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:27:33.182Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-07T03:28:47.983Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:28:47.983Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:28:47.983Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:28:47.983Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:28:47.987Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-07T03:36:00.072Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:36:00.072Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

- created: 2026-10-07T03:36:00.072Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T03:36:00.077Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-07T10:00:12.491Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

- created: 2026-10-07T10:00:12.491Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:00:12.494Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-07T10:58:47.456Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-07T10:58:47.459Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```
