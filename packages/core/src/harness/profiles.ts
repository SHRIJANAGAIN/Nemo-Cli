/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The coding-agent half of the method: caps, vocabulary, and where the
 * improvement levers live for a terminal coding agent.
 *
 * The method itself is substrate-agnostic. What makes a harness good is
 * not: a coding agent is judged on the repository it leaves behind, so the
 * levers are discovery, verification, recovery and the shape of the change
 * rather than the shape of a slide deck.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import type { HarnessProfile } from "./types.js"
import { RESERVED_SCRIPTS, NEMO_SURFACE } from "./tree.js"

/**
 * Nemo's profile.
 *
 * `invLevers` are ways of working: how the agent finds code, runs checks,
 * recovers from a failed command, and knows when it is done. `domLevers`
 * are things a practitioner of the area knows: the repository's own
 * conventions, the build/test commands, compatibility promises, and the
 * shape of the change the user asked for. The split matters: a candidate
 * that straddles both is not dimension-scoped, and the blend hides which
 * lever did the work.
 */
export const CODING_AGENT_PROFILE: HarnessProfile = {
  work: "a request to change a repository, made in the user's own words",
  domainWord: "area",
  deliverableWord: "change",
  invLevers: [
    "- DISCOVERY: how the agent finds the right file before writing (search, read, symbol lookup).",
    "- VERIFICATION: which check falsifies the change, and how narrow it can be (single test, typecheck, lint).",
    "- RECOVERY: what to do after a failed command (read the error, narrow the command, stop repeating).",
    "- BOUNDED WORK: how the agent keeps a large change reviewable (one concern at a time, no drive-by edits).",
    "- COMPLETION: how the agent knows it is done, and what it must report (what changed, what was run, what was not).",
    "- SAFETY: when to stop and ask instead of guessing (destructive commands, secrets, ambiguous scope).",
  ].join("\n"),
  domLevers: [
    "- THE ASK: what the user actually wants to be true when the work is done, and the scope they did not ask for.",
    "- REPOSITORY CONVENTIONS: naming, structure, error handling and test style already used here.",
    "- CONTROLLING SOURCES: the code, schema, docs and config that decide whether a claim is true.",
    "- COMPATIBILITY: public APIs, migrations, versioning promises and callers that cannot break.",
    "- THE CHANGE: the files that must move together for the request to hold.",
    "- AUDIENCE: who reviews this, and what they need in the summary to trust it.",
  ].join("\n"),
  alwaysOnMax: NEMO_SURFACE.alwaysOnMax,
  allowSubagents: true,
  reservedScripts: RESERVED_SCRIPTS,
  forbiddenPromptWords: ["rubric", "grader", "pass_rate", "benchmark score", "leaderboard"],
}
