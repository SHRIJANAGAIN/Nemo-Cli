---
description: Convene a Nemo Council scientific debate — rival hypotheses argue it out, consensus wins.
argument-hint: "[topic + rival hypotheses]"
---

# /debate - Nemo Council

Coordinate several teammates working as a scientific debate. One session acts as
lead (you) — teammates are full sessions with their own context that message
each other directly. Unlike a plain subagent (reports back only), teammates
challenge each other's theories like a debate, then you synthesize consensus.

**Nothing spawns without the user's say-so.** Describe the task and the team
shape in plain English, or call `nemo__Debate` with explicit hypotheses.

## When to use

- Debugging with competing hypotheses — teammates test different theories in
  parallel and argue them out. Beats a single agent anchoring on the first cause.
- Research & review — independent lenses (security, performance, coverage).
- New modules — each teammate owns a separate piece.

**When not to:** sequential work, same-file edits (teammates overwrite each
other — split along file boundaries), or heavily dependent tasks. Each teammate
burns its own session tokens.

## How to run

1. Pick 2-5 rival hypotheses (cap 5).
2. Call `nemo__Debate` with `topic` + `hypotheses`, or spawn via
   `nemo__RunTeam` with the debate prompt shape from
   `buildDebateTasks` (each prompt names its hypothesis + disproof targets).
3. Teammates gather evidence, challenge via `nemo__SendMessage`, concede
   explicitly when disproven, and close with SUPPORTED / DISPROVEN / UNRESOLVED.
4. Synthesize: only verdicts with surviving evidence count as consensus. Write
   the consensus + dissent to the findings doc.

## Tips

- Start with 3 teammates. Past 5, coordination cost beats parallelism.
- Give each teammate enough context — they do NOT inherit your conversation.
- Steer mid-run: peek via `nemo__Fleet`, message via `nemo__SendMessage`.
