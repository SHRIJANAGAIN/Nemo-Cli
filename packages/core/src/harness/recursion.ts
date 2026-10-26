/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Parallel and sequential task-level recursion.
 *
 * Each mode schedules 4k rollouts and 3k improvement stages, including the
 * shared base executions. An invalid proposal gets one retry before it
 * inherits the current harness; a transport failure is a separate attempt
 * count and never a separate stage.
 *
 * `agg` is WIDTH: 2k independent candidates from the same evidence, then k
 * independent compositions. `seq` is DEPTH: k nested passes where each
 * round edits the previous checkpoint and sees every earlier round.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import * as fs from "fs"
import * as path from "path"
import type {
  HarnessLedgerSummary,
  HarnessMode,
  HarnessModeResult,
  HarnessRun,
  HarnessStage,
  HarnessTree,
} from "./types.js"
import type { HarnessTask, RolloutPort } from "./ports.js"
import { mapLimit } from "./ports.js"
import {
  RESERVED_SCRIPTS,
  autotrigger,
  diffSummary,
  diversity,
  readTree,
  validate,
  writeTree,
  type SurfaceSpec,
} from "./tree.js"
import { buildContext, mission, assertTreeHasNoGraderVerdicts } from "./context.js"
import { Proposer, ProposerError } from "./proposer.js"
import { CODING_AGENT_PROFILE } from "./profiles.js"
import { aggregatePrompt, composeRoundPrompt, proposePrompt } from "./prompts.js"
import { HarnessLedger } from "./ledger.js"
import { markComplete } from "./runmark.js"
import type { HarnessProfile } from "./types.js"

/** Stage-level attempts: an invalid proposal gets exactly one retry. */
export const STAGE_ATTEMPTS = 2

/** Transport-level attempts inside one stage attempt. */
export const TRANSPORT_ATTEMPTS = 2

/** How many stages may run at once. */
export const PHASE_WIDTH = 4

/** The stage label for round `t` of a mode. */
export function stageLabel(dim: "INV" | "DOM", index: number): string {
  return `${dim.toLowerCase()}${index}`
}

export interface RecursionDeps {
  task: HarnessTask
  surface: SurfaceSpec
  /** Model sessions. One `Proposer` may be shared across modes and tasks. */
  proposer: Proposer
  /** Rollout execution. */
  rollout: RolloutPort
  /** Where harnesses, runs and per-stage evidence land. */
  workDir: string
  /** The k shared reference executions, already finished. */
  baseRuns: readonly HarnessRun[]
  /** The harness every candidate starts from. */
  baseTree: HarnessTree
  /** The area's library, exported into each stage's evidence. */
  libraryDir?: string | null
  /** Globally stable run id for a label. */
  runIdOf: (label: string) => string
  profile?: HarnessProfile
  proposeWorkers?: number
  rolloutWorkers?: number
  /** Answer-key globs, forwarded to the evidence guard. */
  leakGlobs?: readonly string[]
  log?: (line: string) => void
}

/** Run one recursion mode. */
export async function runMode(
  mode: HarnessMode,
  k: number,
  deps: RecursionDeps,
): Promise<HarnessModeResult> {
  if (mode === "agg") return runParallel(k, deps)
  if (mode === "seq") return runSequential(k, deps)
  throw new Error(
    `unknown mode ${JSON.stringify(mode)}; the method has exactly two: agg (parallel) and seq (sequential)`,
  )
}

/** WIDTH: 2k independent candidates, then k independent compositions. */
export async function runParallel(k: number, deps: RecursionDeps): Promise<HarnessModeResult> {
  const profile = deps.profile ?? CODING_AGENT_PROFILE
  const ledger = new HarnessLedger("agg", deps.task.id, k)
  for (const run of deps.baseRuns) ledger.rollout(run.label, run.costUsd)

  const result = emptyResult("agg", deps.task.id, k, ledger)
  for (const run of deps.baseRuns) result.rollouts[run.label] = run

  const contextDir = path.join(deps.workDir, "context")
  const baseDir = writeTree(deps.surface, deps.baseTree, path.join(deps.workDir, "harnesses", "base"))

  const specs: Array<{ label: string; dim: "INV" | "DOM"; index: number }> = []
  for (let index = 1; index <= k; index++) {
    for (const dim of ["INV", "DOM"] as const) {
      specs.push({ label: stageLabel(dim, index), dim, index })
    }
  }

  const stages = await mapLimit(specs, deps.proposeWorkers ?? PHASE_WIDTH, (spec) =>
    runStage({
      label: spec.label,
      dim: spec.dim,
      job: proposePrompt({ dimension: spec.dim, k, index: spec.index, round: null, profile }),
      fallback: deps.baseTree,
      deps,
      profile,
      contextDir,
      harnessDir: baseDir,
      libraryDir: deps.libraryDir ?? null,
      pool: [],
      decisions: {},
    }),
  )
  recordStages(ledger, stages)
  for (const stage of stages) {
    result.stages.push(stage)
    result.trees[stage.label] = stage.tree
  }

  const stageRuns = await rollMany(
    deps,
    stages.map((stage) => ({ label: stage.label, tree: stage.tree })),
  )
  for (const [label, run] of Object.entries(stageRuns)) {
    result.rollouts[label] = run
    ledger.rollout(label, run.costUsd)
  }

  const poolEvidence = stages.map((stage) => ({
    label: stage.label,
    harnessDir: path.join(deps.workDir, "harnesses", stage.label),
    run: result.rollouts[stage.label] ?? null,
  }))
  const decisions: Record<string, string> = {}
  for (const stage of stages) decisions[stage.label] = stage.notes || stage.error

  const aggLabels = Array.from({ length: k }, (_, index) => `agg${index + 1}`)
  const compositions = await mapLimit(aggLabels, deps.proposeWorkers ?? PHASE_WIDTH, (label, index) =>
    runStage({
      label,
      dim: "AGG",
      job: aggregatePrompt({ k, index: index + 1, profile }),
      fallback: deps.baseTree,
      deps,
      profile,
      contextDir,
      harnessDir: baseDir,
      libraryDir: deps.libraryDir ?? null,
      pool: poolEvidence,
      decisions,
    }),
  )
  recordStages(ledger, compositions)
  for (const stage of compositions) {
    result.stages.push(stage)
    result.trees[stage.label] = stage.tree
    result.finals.push(stage.label)
  }

  const finalRuns = await rollMany(
    deps,
    compositions.map((stage) => ({ label: stage.label, tree: stage.tree })),
  )
  for (const [label, run] of Object.entries(finalRuns)) {
    result.rollouts[label] = run
    ledger.rollout(label, run.costUsd)
  }

  result.similarity = diversity(
    Object.fromEntries(compositions.map((stage) => [stage.label, stage.tree])),
  )
  finish(result, ledger, stages.length > 0)
  return result
}

/** DEPTH: k nested passes over the same shared base evidence. */
export async function runSequential(k: number, deps: RecursionDeps): Promise<HarnessModeResult> {
  const profile = deps.profile ?? CODING_AGENT_PROFILE
  const ledger = new HarnessLedger("seq", deps.task.id, k)
  for (const run of deps.baseRuns) ledger.rollout(run.label, run.costUsd)

  const result = emptyResult("seq", deps.task.id, k, ledger)
  for (const run of deps.baseRuns) result.rollouts[run.label] = run

  const contextDir = path.join(deps.workDir, "context")
  let currentHarness: HarnessTree = { ...deps.baseTree }
  let history: Array<{ label: string; harnessDir: string; run: HarnessRun | null }> = []

  for (let round = 1; round <= k; round++) {
    const currentLabel = round > 1 ? `c${round - 1}` : "base"
    const currentDir = writeTree(
      deps.surface,
      currentHarness,
      path.join(deps.workDir, "harnesses", currentLabel),
    )

    const specs: Array<{ label: string; dim: "INV" | "DOM" }> = [
      { label: `inv${round}`, dim: "INV" },
      { label: `dom${round}`, dim: "DOM" },
    ]
    const decisionsSoFar: Record<string, string> = {}
    for (const stage of result.stages) decisionsSoFar[stage.label] = stage.notes || stage.error

    const stages = await mapLimit(specs, deps.proposeWorkers ?? 2, (spec) =>
      runStage({
        label: spec.label,
        dim: spec.dim,
        job: proposePrompt({
          dimension: spec.dim,
          k,
          index: round,
          round: k > 1 ? round : null,
          profile,
        }),
        fallback: currentHarness,
        deps,
        profile,
        contextDir,
        harnessDir: currentDir,
        libraryDir: deps.libraryDir ?? null,
        pool: history,
        decisions: decisionsSoFar,
      }),
    )
    recordStages(ledger, stages)
    for (const stage of stages) {
      result.stages.push(stage)
      result.trees[stage.label] = stage.tree
    }

    const stageRuns = await rollMany(
      deps,
      stages.map((stage) => ({ label: stage.label, tree: stage.tree })),
    )
    for (const [label, run] of Object.entries(stageRuns)) {
      result.rollouts[label] = run
      ledger.rollout(label, run.costUsd)
    }

    const roundPool = [
      ...history,
      ...stages.map((stage) => ({
        label: stage.label,
        harnessDir: path.join(deps.workDir, "harnesses", stage.label),
        run: result.rollouts[stage.label] ?? null,
      })),
    ]
    const checkpoint = `c${round}`
    const decisions: Record<string, string> = {}
    for (const stage of result.stages) decisions[stage.label] = stage.notes || stage.error

    const comp = await runStage({
      label: checkpoint,
      dim: "COMPOSE",
      job:
        k === 1
          ? aggregatePrompt({ k: 1, index: 1, profile })
          : composeRoundPrompt({ k, round, profile }),
      fallback: currentHarness,
      deps,
      profile,
      contextDir,
      harnessDir: currentDir,
      libraryDir: deps.libraryDir ?? null,
      pool: roundPool,
      decisions,
    })
    recordStages(ledger, [comp])
    result.stages.push(comp)
    result.trees[checkpoint] = comp.tree

    const checkpointRun = await rollOne(deps, checkpoint, comp.tree)
    result.rollouts[checkpoint] = checkpointRun
    ledger.rollout(checkpoint, checkpointRun.costUsd)

    history = [
      ...roundPool,
      {
        label: checkpoint,
        harnessDir: path.join(deps.workDir, "harnesses", checkpoint),
        run: checkpointRun,
      },
    ]
    currentHarness = comp.tree
  }

  result.finals = Array.from({ length: k }, (_, index) => `c${index + 1}`)
  finish(result, ledger, /*ran*/ true)
  return result
}

interface StageInput {
  label: string
  dim: HarnessStage["dim"]
  job: string
  fallback: HarnessTree
  deps: RecursionDeps
  profile: HarnessProfile
  contextDir: string
  harnessDir: string
  libraryDir: string | null
  pool: Array<{ label: string; harnessDir: string | null; run: HarnessRun | null }>
  decisions: Record<string, string>
}

/** Build evidence, propose an edit, and retry an invalid proposal once. */
async function runStage(input: StageInput): Promise<HarnessStage> {
  const surface = input.deps.surface
  let evidence: ReturnType<typeof buildContext>
  let brief: string
  try {
    evidence = buildContext({
      dest: path.join(input.contextDir, input.label),
      task: input.deps.task,
      rollouts: input.deps.baseRuns,
      harnessDir: input.harnessDir,
      libraryDir: input.libraryDir,
      pool: input.pool,
      decisions: input.decisions,
      leakGlobs: input.deps.leakGlobs ?? [],
    })
    brief = mission(evidence, { job: input.job })
  } catch (error) {
    return {
      label: input.label,
      dim: input.dim,
      tree: { ...input.fallback },
      keptBase: false,
      fellBack: true,
      error: `could not build evidence: ${describe(error)}`.slice(0, 400),
      attempts: 0,
      notes: "",
      usd: 0,
      cached: false,
    }
  }

  let error = ""
  let spentUsd = 0
  let spentCalls = 0
  let allCached = true

  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt++) {
    let reply
    try {
      reply = await input.deps.proposer.call(
        error
          ? `${brief}\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${error}\n\nFix it in \`context/harness/\` and reply again.`
          : brief,
        evidence.root,
        `${input.label}.a${attempt}`,
        { harvest: "context/harness", maxAttempts: TRANSPORT_ATTEMPTS },
      )
    } catch (failure) {
      error = describe(failure)
      if (failure instanceof ProposerError) {
        spentCalls += failure.attempts || TRANSPORT_ATTEMPTS
        spentUsd += failure.costUsd
      } else {
        spentCalls += TRANSPORT_ATTEMPTS
      }
      allCached = false
      break
    }

    spentUsd += reply.costUsd
    spentCalls += reply.cached ? 0 : Math.max(1, reply.attempts)
    allCached = allCached && reply.cached

    if (reply.workspace === null) {
      error =
        "the harness directory did not come back from the session; edit the files in " +
        "`context/harness/` in place"
      continue
    }
    const rejected: string[] = []
    const next = readTree(surface, reply.workspace, rejected)
    if (Object.keys(next).length === 0) {
      error = "`context/harness/` came back empty -- edit the files, do not delete them all"
      continue
    }
    if (rejected.length > 0) {
      error =
        "these files are off the editable surface and were not applied: " +
        rejected.sort().slice(0, 6).join(", ") +
        ". Component names must be lowercase letters, digits, `_` or `-` " +
        `(e.g. \`${surface.skillDir}/doc_review/SKILL.md\`, \`${surface.scriptDir}/check_totals.mjs\`).`
      continue
    }

    const accepted = acceptTree(surface, next, input.fallback, input.label, input.profile, input.deps.log)
    if (accepted.error) {
      error = accepted.error
      // Show the retry exactly what it proposed, so the second attempt can fix it.
      writeTree(surface, next, path.join(evidence.root, "harness"))
      continue
    }
    const notes = /<notes>([\s\S]*?)<\/notes>/.exec(reply.text)
    return {
      label: input.label,
      dim: input.dim,
      tree: next,
      keptBase: accepted.keptBase,
      fellBack: false,
      error: "",
      attempts: spentCalls,
      notes: (notes ? notes[1]! : reply.text).trim(),
      usd: round(spentUsd),
      cached: allCached,
    }
  }

  return {
    label: input.label,
    dim: input.dim,
    tree: { ...input.fallback },
    keptBase: false,
    fellBack: true,
    error: error.slice(0, 400),
    attempts: spentCalls,
    notes: "",
    usd: round(spentUsd),
    cached: allCached,
  }
}

/** Repair, then validate, a proposed tree: `keptBase` or the error to retry with. */
function acceptTree(
  surface: SurfaceSpec,
  next: HarnessTree,
  fallback: HarnessTree,
  label: string,
  profile: HarnessProfile,
  log?: (line: string) => void,
): { keptBase: boolean; error: string } {
  const triggered = autotrigger(surface, next, { alwaysOnMax: profile.alwaysOnMax })
  if (triggered.length > 0) {
    log?.(`  [${label}] auto-triggered skill(s): ${triggered.join(", ")}`)
  }
  const changed = diffSummary(surface, fallback, next)
  const keptBase = changed.added.length === 0 && changed.removed.length === 0 && changed.modified.length === 0
  try {
    validate(surface, next, {
      allowSubagents: profile.allowSubagents,
      alwaysOnMax: profile.alwaysOnMax,
      reservedScripts: new Set([...RESERVED_SCRIPTS, ...profile.reservedScripts]),
    })
    assertTreeHasNoGraderVerdicts(next)
  } catch (error) {
    return { keptBase, error: describe(error) }
  }
  return { keptBase, error: "" }
}

/** Materialise a harness and roll it once. A dead rollout is recorded, never raised. */
async function rollOne(
  deps: RecursionDeps,
  label: string,
  tree: HarnessTree | null,
): Promise<HarnessRun> {
  const harnessDir =
    tree === null ? null : writeTree(deps.surface, tree, path.join(deps.workDir, "harnesses", label))
  const runId = deps.runIdOf(label)
  const runDir = path.join(deps.workDir, "runs", label)
  fs.mkdirSync(runDir, { recursive: true })
  try {
    const run = await deps.rollout.run({
      task: deps.task,
      label,
      runId,
      harnessDir,
      runDir,
    })
    const normalized: HarnessRun = {
      ...run,
      label,
      runId,
      runDir: run.runDir || runDir,
      costUsd: Number.isFinite(run.costUsd) ? run.costUsd : 0,
      wallS: Number.isFinite(run.wallS) ? run.wallS : 0,
    }
    if (normalized.ok) markComplete(runDir, { runId, harnessDir })
    return normalized
  } catch (error) {
    return {
      label,
      runId,
      runDir,
      ok: false,
      delivered: false,
      transcript: "",
      deliverable: "",
      deliverableFiles: {},
      error: describe(error),
      costUsd: 0,
      wallS: 0,
    }
  }
}

/** Roll independent harnesses concurrently, preserving the input order of the result. */
async function rollMany(
  deps: RecursionDeps,
  items: ReadonlyArray<{ label: string; tree: HarnessTree }>,
): Promise<Record<string, HarnessRun>> {
  const runs = await mapLimit(items, deps.rolloutWorkers ?? PHASE_WIDTH, (item) =>
    rollOne(deps, item.label, item.tree),
  )
  const out: Record<string, HarnessRun> = {}
  for (const run of runs) out[run.label] = run
  return out
}

function recordStages(ledger: HarnessLedger, stages: readonly HarnessStage[]): void {
  for (const stage of stages) {
    ledger.session(stage.label, { usd: stage.usd, attempts: stage.attempts, cached: stage.cached })
  }
}

function emptyResult(
  mode: HarnessMode,
  taskId: string,
  k: number,
  ledger: HarnessLedger,
): HarnessModeResult {
  return {
    mode,
    taskId,
    k,
    stages: [],
    trees: {},
    rollouts: {},
    finals: [],
    similarity: null,
    errors: [],
    ledger: ledger.summary(),
    ok: false,
    fellBack: [],
    keptBase: [],
  }
}

function finish(result: HarnessModeResult, ledger: HarnessLedger, ran: boolean): void {
  ledger.assertIdentity()
  result.ledger = ledger.summary()
  result.fellBack = result.stages.filter((stage) => stage.fellBack).map((stage) => stage.label)
  result.keptBase = result.stages.filter((stage) => stage.keptBase).map((stage) => stage.label)
  result.ok = ran && result.finals.length > 0 && result.errors.length === 0
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** The ledger summary type is re-exported so callers can type a serialised result. */
export type { HarnessLedgerSummary }
