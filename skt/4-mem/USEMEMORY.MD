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
- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T05:02:01.912Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:32.407Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:29.197Z
- use_count: 0
- tags: []

- created: 2026-10-04T14:44:54.366Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-04T14:44:54.370Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T05:02:01.912Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:32.407Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.195Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:29.197Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### mem_muus3b70
- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T05:02:01.912Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:32.407Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:29.197Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:29.197Z
- use_count: 0
- tags: []

The user's name is Shri Shruti. Address them as Shri Shruti.

Notes: previously clarified this after saying "you forget" — user expects me to retain personal facts across sessions, so confirm and save when they share identity/preferences info.

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T05:02:01.912Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:32.407Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### MEM-00000001
- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T05:02:01.912Z
- use_count: 0
- tags: []

- created: 2026-10-05T04:57:32.406Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T04:57:32.407Z
- use_count: 0
- tags: []

shri shruti

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T05:02:01.912Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### MEM-00000002
- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

- created: 2026-10-05T05:02:01.911Z
- category: preference
- confidence: 1.0
- source: user
- last_used: 2026-10-05T05:02:01.912Z
- use_count: 0
- tags: []

in your pocket, never tears and never runs out

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

- created: 2026-10-05T08:58:34.520Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T08:58:34.523Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

- created: 2026-10-05T10:34:28.887Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T10:34:28.891Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:50:07.167Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:50:07.170Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-05T11:51:45.715Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:51:45.715Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T10:03:28.806Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:51:45.715Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-06T08:42:05.458Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:51:45.715Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:42:54.075Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:51:45.715Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:37:47.547Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:51:45.715Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T13:33:52.836Z
- use_count: 0
- tags: []

- created: 2026-10-05T11:51:45.715Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-05T11:51:45.717Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
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
- last_used: 2026-10-06T10:11:47.665Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```
