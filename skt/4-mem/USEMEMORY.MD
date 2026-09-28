# SKT AI LABS - User Memory (Editable Interface)

This is the **editable** memory store. When the user says "remember this" or "add to memory", the assistant writes here. The canonical summarized store lives in `MEMORY.MD` and is read-only for the assistant — it can be searched but not appended to. Always check `MEMORY.MD` for older context before responding.

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

The agent uses `4-mem/memory.ts loadMemory` to inject relevant entries into the system prompt based on the current task context. It also reads from `MEMORY.MD` for older summarized context.

## Active entries

<!-- The assistant appends entries below. Do not edit by hand. -->
