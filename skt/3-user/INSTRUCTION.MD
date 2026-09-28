# SKT AI LABS - User Instructions Store

This file is the canonical store for **all standing instructions** the user has given the assistant. Every time the user says something like "always do X" or "never do Y", the assistant appends a row here so the instruction persists across sessions and is available to every agent in the swarm.

## Schema

| timestamp | instruction | scope | active |
|-----------|-------------|-------|--------|
| 2026-09-03T10:00:00Z | "Always use Apache 2.0 headers" | global | true |

- **scope**: `global` (all projects), `project` (this project only), `session` (this session only)
- **active**: `true` while in force; set to `false` when the user revokes it

## Active global instructions

<!-- The assistant appends rows here. Do not edit by hand. -->

| 2026-09-07T07:56:00Z | "If a tool fails or returns an error, store the mistake in skt/1-errors/mistakes.json and learn from it; never ignore tool failures or continue as if they succeeded" | global | true |

## Active project instructions

<!-- The assistant appends rows here. Do not edit by hand. -->

## Revoked instructions

<!-- The assistant moves rows here when the user says "stop doing X". Do not edit by hand. -->

## How instructions are loaded

At session start, the agent reads this file and injects the active instructions into the system prompt. The eval system (`5-eval/eval.py`) checks every assistant response against these instructions and flags any violation as a mistake.
