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
- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.193Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.391Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:42:15.248Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.245Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:42:15.246Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### MEM-00000003
- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.193Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.391Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:42:15.248Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.246Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:42:15.246Z
- use_count: 0
- tags: []

pass the raw

### # SKT AI LABS - User Memory (Active)
- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.193Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.391Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:42:15.248Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### MEM-00000004
- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.193Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.391Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:42:15.247Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:42:15.248Z
- use_count: 0
- tags: []

pass a non-empty `diff`

### # SKT AI LABS - User Memory (Active)
- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.391Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### MEM-00000005
- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.390Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.391Z
- use_count: 0
- tags: []

pass the raw

### # SKT AI LABS - User Memory (Active)
- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### MEM-00000006
- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

- created: 2026-09-30T13:43:03.392Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-09-30T13:43:03.392Z
- use_count: 0
- tags: []

pass a non-empty `diff`

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:19:29.817Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:19:29.826Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:27:06.536Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:27:06.540Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T03:46:41.160Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:46:41.160Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:46:41.160Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:46:41.160Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:46:41.160Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:46:41.160Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:46:41.160Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:46:41.164Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T03:47:21.599Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:47:21.599Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:47:21.599Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:47:21.599Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:47:21.599Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:47:21.599Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:47:21.602Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T03:53:09.173Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:53:09.173Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:53:09.173Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:53:09.173Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:53:09.173Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:53:09.177Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:55:44.289Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T03:56:27.562Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T04:34:34.194Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T10:39:23.108Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```
