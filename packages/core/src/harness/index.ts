/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The recursive harness.
 *
 * A harness is the system around the model: the system prompt, the
 * guardrails, the tool guidance, the memory, the skills, the subagents,
 * the helper scripts and the plugins. This module makes that harness
 * something the agent can IMPROVE ON ITS OWN:
 *
 * - task-level recursion: propose an edit, probe it against the same task,
 *   compose a refined harness from the contrast between executions;
 * - harnessing-level recursion: keep the harness that was adopted and the
 *   lesson it taught, and read them on the next task in that area.
 *
 * The engine never talks to a provider. `ports.ts` is the seam, so the
 * host supplies the coding agent and the method stays portable.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

export * from "./types.js"
export * from "./tree.js"
export * from "./ledger.js"
export * from "./runmark.js"
export * from "./summary.js"
export * from "./library.js"
export * from "./selection.js"
export * from "./profiles.js"
export * from "./prompts.js"
export * from "./materialize.js"
export * from "./ports.js"
export * from "./context.js"
export * from "./proposer.js"
export * from "./recursion.js"
export * from "./schedule.js"
