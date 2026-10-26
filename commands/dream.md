---
description: Consolidate Nemo memory — dedupe, drop expired, enforce caps, flag contradictions.
argument-hint: "[focus text | nightly | consolidate | status]"
---

# /dream - Nemo Memory Consolidation

Clean up persistent memory (`memory` tool store) so fresh sessions orient fast.
Deterministic pass first, model judgment second. Never auto-rewrite contradictions.

## Forms

`/dream` — full pass now, foreground, with full tool access.
`/dream <focus>` — same, biased to trailing text (e.g. `/dream focus on auth refactor`).
`/dream status` — read-only: run `dream` tool `status`, report, change nothing.
`/dream consolidate` — bare deterministic body: run `dream` tool `consolidate`, then resolve flags by hand.
`/dream nightly` — schedule recurring nightly consolidation via `nemo__CronCreate` with a random minute 00:00-05:59 local, recurring true, prompt `/dream consolidate`. Re-running replaces the old job (list via `nemo__CronList`, delete the old id first).

## The 4-phase pass

1. **Orient** — `dream` `status` + `memory` `list`. Note counts, bytes, cap headroom. Skim, never dump whole transcripts.
2. **Gather** — narrow `memory` `search` per focus area. Flag drift vs current code (read files with `read_file`, search with `grep`).
3. **Consolidate** — run `dream` `consolidate`. Then by hand: convert relative dates to absolute ISO dates via `memory` save/forget, merge new signal, keep newest on conflicts only with user-visible reason.
4. **Prune & index** — verify caps (200 entries / ~25KB). Drop superseded pointers. Contradictions are flagged, never silently merged.

## Rules

- Exact dupes + expired entries: deterministic tool deletes them.
- Contradictions + relative dates: model proposes, user approves, then `memory` forget/save.
- Secrets: redact before saving. Never persist tokens, keys, PII.
- Report at end: scanned/kept/expired/dupes/capped + contradictions + relative dates.
