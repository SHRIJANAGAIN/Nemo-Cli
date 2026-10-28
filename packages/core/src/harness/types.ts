/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Types for the recursive harness.
 *
 * The method is adapted from Harness² ("Recursive Agent Harnessing for an
 * Open World", Copyright 2026 Google LLC, Apache License 2.0) — see
 * packages/core/src/harness/NOTICE.md for the full attribution.
 *
 * The engine is model-agnostic on purpose: it never talks to a provider.
 * Every model call goes through the ports in `ports.ts`, so the whole
 * recursion can be driven deterministically in tests.
 */

/**
 * A harness is a flat map of relative path -> file body.
 *
 * The edit contract is *omitted-is-inherited*: a proposal emits only the
 * files it changes, and a file that disappears from the map is a deletion.
 * The tree IS the proposal — there is no separate patch format to
 * reproduce, and nothing the proposer writes in prose changes the harness.
 */
export type HarnessTree = Record<string, string>

/** The on-disk recursion token. `agg` = width, `seq` = depth. */
export type HarnessMode = "agg" | "seq"

/**
 * Which dimension owns an edit.
 *
 * - `INV` — how the agent works: tool use, procedure, error handling,
 *   sequencing, completion discipline. Never subject matter.
 * - `DOM` — what a practitioner knows about the work: the deliverable, the
 *   audience, the controlling sources, the required structure. Never
 *   commands or retries.
 * - `AGG` — compose one final from the parallel candidate pool.
 * - `COMPOSE` — compose one round from the sequential history.
 */
export type HarnessDimension = "INV" | "DOM" | "AGG" | "COMPOSE"

/** One improvement stage: the accepted proposal plus its decision notes. */
export interface HarnessStage {
  /** Stable label: `inv1`, `dom2`, `agg1`, `c3`, ... */
  label: string
  dim: HarnessDimension
  /** The tree this stage produced (the accepted proposal). */
  tree: HarnessTree
  /** The proposal was byte-identical to the fallback tree. */
  keptBase: boolean
  /** The stage failed; `tree` is the inherited fallback. */
  fellBack: boolean
  /** Why the stage failed, if it did. */
  error: string
  /** Proposer attempts spent on this stage. */
  attempts: number
  /** The decision notes: one line per change, citing the evidence. */
  notes: string
  /** Cost of the sessions this stage spent, in USD. */
  usd: number
  /** Every attempt was served from cache. */
  cached: boolean
}

/**
 * What the method knows about one finished rollout.
 *
 * It never carries a score: the method is ground-truth-free, so a rollout
 * is "did it deliver" and "what did it do" — never "how good was it".
 */
export interface HarnessRun {
  label: string
  /** Stable run id: `<namespace>/<task>/<label>`. */
  runId: string
  /** The directory the rollout wrote to. */
  runDir: string
  ok: boolean
  /** The rollout produced a deliverable. */
  delivered: boolean
  /** The full trajectory, rendered as text. */
  transcript: string
  /** The artifact the rollout produced, as text. */
  deliverable: string
  /** Per-artifact text, when the runtime can split it. */
  deliverableFiles: Record<string, string>
  error: string
  costUsd: number
  wallS: number
}

/** One advisory line the composer consumed, keyed by the stage label. */
export type HarnessDecisions = Record<string, string>

/**
 * A transferable lesson.
 *
 * A lesson is only "evidence-supported" when all three of `cue`, `lesson`
 * and `evidence` are present — without them it is a guess, and a guess in
 * the library poisons every later task.
 */
export interface HarnessLesson {
  /** The shape of situation this applies to (not this task's facts). */
  cue: string
  /** The operation to perform on a harness, naming the component. */
  lesson: string
  /** The edit rows and execution contrast this rests on. */
  evidence: string
  /** `high` | `medium` | `low`, and why. */
  confidence: string
  /** The raw edit rows, kept for the record. */
  edits: string
}

/** A candidate in the selection pool: a final harness plus its rollout. */
export interface HarnessCandidate {
  label: string
  tree: HarnessTree
  run: HarnessRun
}

/** The result of one recursion mode. */
export interface HarnessModeResult {
  mode: HarnessMode
  taskId: string
  /** The task-level recursion budget (`k`). */
  k: number
  stages: HarnessStage[]
  trees: Record<string, HarnessTree>
  rollouts: Record<string, HarnessRun>
  /** `agg1..aggk` in parallel mode, `c1..ck` in sequential mode. */
  finals: string[]
  /** Line-Jaccard diversity across the finals (parallel mode only). */
  similarity: HarnessDiversity | null
  errors: string[]
  /** Budget identity: 4k rollouts, 3k sessions, no duplicate labels. */
  ledger: HarnessLedgerSummary
  /** `true` when every final delivered and no stage fell back. */
  ok: boolean
  /** Labels of the stages that inherited their fallback tree. */
  fellBack: string[]
  /** Labels of the stages whose proposal was byte-identical to the fallback. */
  keptBase: string[]
}

/** Pairwise similarity between candidate harnesses. */
export interface HarnessDiversity {
  n: number
  nDistinct: number
  meanLineJaccard: number
}

/** Budget identity for one recursion run. */
export interface HarnessLedgerSummary {
  mode: string
  taskId: string
  k: number
  /** Rollouts: expected 4k. */
  rollouts: number
  expectedRollouts: number
  /** Proposer sessions: expected 3k. */
  sessions: number
  expectedSessions: number
  /** Sum of every stage's attempts (retries included). */
  sessionAttempts: number
  usd: number
  rolloutUsd: number
  sessionUsd: number
}

/** The outcome of a blind selection over the finals. */
export interface HarnessSelection {
  taskId: string
  mode: HarnessMode
  k: number
  /** Anonymous id of the chosen candidate (`A`, `B`, ...). */
  chosenId: string
  /** Real label of the chosen candidate. */
  chosenLabel: string
  /** The run id of the chosen candidate. */
  chosenRunId: string
  /** The chosen candidate was a base rollout. */
  chosenIsBase: boolean
  /** Why the selector picked it. */
  why: string
  /** Anonymous id -> real label. */
  idMap: Record<string, string>
  /** Candidates dropped, with the cause. */
  dropped: string[]
  nCandidates: number
  ok: boolean
  /** The selection fell back (selector failed) — not a real pick. */
  fallback: boolean
  error: string
  /** Selector cost, in USD. */
  usd: number
  /** The evidence the selector saw: `deliverable` or `trajectory`. */
  evidence: "deliverable" | "trajectory"
  /** The lesson extracted from the adoption, when there was one. */
  experience: HarnessLesson | null
  /** The pool had a single candidate (k=1) — no selector session ran. */
  trivial: boolean
}

/** One reply from an improver / selector session. */
export interface HarnessReply {
  label: string
  text: string
  ok: boolean
  costUsd: number
  wallS: number
  attempts: number
  cached: boolean
  error: string
  /** Where the audit trail was written, when it was. */
  auditDir: string | null
  /** The harvested workspace, when the call asked for one. */
  workspace: string | null
}

/** One proposer / composer result. */
export interface HarnessProposal {
  tree: HarnessTree
  notes: string
}

/** A profile is the coding-agent half of the method: caps and vocabulary. */
export interface HarnessProfile {
  /** What the work is called, in prose. */
  work: string
  /** The grouping unit: language, area, stack. */
  domainWord: string
  /** The artifact the task asks for. */
  deliverableWord: string
  /** What the INV dimension may pull. */
  invLevers: string
  /** What the DOM dimension may pull. */
  domLevers: string
  /** The always-on character cap. */
  alwaysOnMax: number
  /** Whether subagents may be proposed. */
  allowSubagents: boolean
  /** Reserved helper scripts the runtime ships. */
  reservedScripts: ReadonlySet<string>
  /** Benchmark-shaped words that must never reach a prompt. */
  forbiddenPromptWords: readonly string[]
}

/** A context tree on disk: what the proposer reads. */
export interface HarnessContextTree {
  root: string
  taskId: string
  rollouts: string[]
  deliverables: string[]
  harnessFiles: number
  library: boolean
  pool: string[]
  failed: string[]
  sourceFiles: number
  decisions: number
  /** Only the paths that actually landed, so the mission describes reality. */
  layout: string
  /** Whether deliverable bodies were written or only their names. */
  deliverablesMode: "contents" | "names"
}
