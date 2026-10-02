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
- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:33:54.908Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:27:38.386Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:55:44.282Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:09:15.350Z
- use_count: 0
- tags: []

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
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:33:54.908Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:27:38.386Z
- use_count: 0
- tags: []

- created: 2026-10-01T03:56:27.556Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:09:15.350Z
- use_count: 0
- tags: []

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
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:33:54.908Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:27:38.386Z
- use_count: 0
- tags: []

- created: 2026-10-01T04:34:34.187Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:09:15.350Z
- use_count: 0
- tags: []

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
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:33:54.908Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:27:38.386Z
- use_count: 0
- tags: []

- created: 2026-10-01T10:39:23.103Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:09:15.350Z
- use_count: 0
- tags: []

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

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:33:54.908Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:27:38.386Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:09:15.341Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:09:15.350Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:33:54.908Z
- use_count: 0
- tags: []

- created: 2026-10-01T15:27:38.380Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T15:27:38.386Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:33:54.906Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:33:54.908Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:49:40.054Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:49:40.057Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:51:07.872Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:51:07.875Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T16:52:21.216Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:52:21.216Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:52:21.216Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:52:21.216Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:52:21.216Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:52:21.216Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:52:21.216Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:52:21.221Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T16:55:47.723Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:55:47.723Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:55:47.723Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:55:47.723Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:55:47.723Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:55:47.723Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:55:47.727Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T16:56:49.908Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:56:49.908Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:56:49.908Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:56:49.908Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

- created: 2026-10-01T16:56:49.908Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T16:56:49.911Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T17:00:44.039Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T17:00:44.039Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T17:00:44.039Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

- created: 2026-10-01T17:00:44.039Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:00:44.044Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-01T17:04:46.495Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-01T17:04:46.495Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

- created: 2026-10-01T17:04:46.495Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-01T17:04:46.501Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-02T02:00:42.079Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

- created: 2026-10-02T02:00:42.079Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:00:42.081Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```

### # SKT AI LABS - User Memory (Active)
- created: 2026-10-02T02:18:31.170Z
- category: context
- confidence: 1.0
- source: user
- last_used: 2026-10-02T02:18:31.173Z
- use_count: 0
- tags: []

This is the **active** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The older store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to.

## Schema

Each entry is a fenced block with a YAML-like front-matter and a free-form body:

```
