/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Choose an existing anonymised final output, then reflect on its
 * refinement evidence.
 *
 * The selection pool is exactly the k finals of one mode. Base executions
 * are not in it, so there is no abstention by construction: the selector
 * must pick one of the attempts the method actually produced.
 *
 * A selector failure falls back to the first delivered final and never
 * raises; an evidence-building bug DOES raise, because that is a bug and
 * not a selection outcome.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import type {
  HarnessLesson,
  HarnessMode,
  HarnessRun,
  HarnessSelection,
} from "./types.js"
import type { HarnessTask } from "./ports.js"
import { Proposer, ProposerError } from "./proposer.js"
import {
  assertNoGraderVerdicts,
  assertTreeHasNoGraderVerdicts,
  buildContext,
  copySource,
  copyTree,
  renderDeliverable,
  safeName,
} from "./context.js"
import { CODING_AGENT_PROFILE } from "./profiles.js"
import { experiencePrompt, selectPrompt } from "./prompts.js"
import type { HarnessProfile } from "./types.js"

/** The one home for selection-pool construction: exactly the k finals of `mode`. */
export function selectionPool(
  mode: HarnessMode,
  k: number,
  rollouts: Record<string, HarnessRun>,
): Record<string, HarnessRun> {
  const labels =
    mode === "agg"
      ? Array.from({ length: k }, (_, index) => `agg${index + 1}`)
      : Array.from({ length: k }, (_, index) => `c${index + 1}`)
  const out: Record<string, HarnessRun> = {}
  for (const label of labels) {
    const run = rollouts[label]
    if (run) out[label] = run
  }
  return out
}

/** Anon id -> label, by canonical sort then a seeded shuffle: stable across reruns. */
export function assignIds(
  labels: readonly string[],
  input: { taskId: string; k: number; mode: string },
): Record<string, string> {
  const seed = parseInt(
    createHash("sha1").update(`${input.taskId}|${input.k}|${input.mode}`).digest("hex").slice(0, 12),
    16,
  )
  const ordered = [...labels].sort()
  const random = mulberry32(seed)
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = ordered[i]!
    ordered[i] = ordered[j]!
    ordered[j] = tmp
  }
  const out: Record<string, string> = {}
  ordered.forEach((label, index) => {
    out[anonId(index)] = label
  })
  return out
}

/** A..Z, AA..AZ, BA... -- always accepted by the choice parser. */
export function anonId(index: number): string {
  let out = ""
  let n = Math.trunc(index) + 1
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Whether a label names a base execution. */
export function isBaseLabel(label: string): boolean {
  return label.startsWith("base")
}

export interface SelectionDeps {
  task: HarnessTask
  mode: HarnessMode
  k: number
  /** The mode's finals, keyed by label. */
  candidates: Record<string, HarnessRun>
  workDir: string
  proposer: Proposer
  profile?: HarnessProfile
  leakGlobs?: readonly string[]
}

/**
 * Pick one output. A selector failure falls back to a delivered final and
 * never raises; a failure to build the evidence tree does raise.
 */
export async function runSelection(deps: SelectionDeps): Promise<HarnessSelection> {
  const profile = deps.profile ?? CODING_AGENT_PROFILE
  const selection = emptySelection(deps.task.id, deps.mode, deps.k)
  const rendered = renderPool(deps.candidates, selection)
  selection.nCandidates = Object.keys(rendered.pool).length
  if (Object.keys(rendered.pool).length === 0) {
    selection.error = "no candidate produced an artifact"
    return selection
  }
  selection.idMap = assignIds(Object.keys(rendered.pool), {
    taskId: deps.task.id,
    k: deps.k,
    mode: deps.mode,
  })

  const root = path.join(deps.workDir, "selection", `${deps.mode}${deps.k}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(root, "candidates"), { recursive: true })
  fs.writeFileSync(
    path.join(root, "task.md"),
    `${[deps.task.request.trim(), deps.task.notes?.trim() ?? ""].filter(Boolean).join("\n\n---\n\n")}\n`,
    "utf8",
  )
  copySource(deps.task.sourceDir ?? null, root, deps.leakGlobs ?? [])

  for (const [id, label] of Object.entries(selection.idMap)) {
    const text = rendered.artifacts[label] ?? ""
    fs.writeFileSync(
      path.join(root, "candidates", `${id}.md`),
      `<!-- candidate ${id}: ${text.length.toLocaleString("en-US")} chars, ` +
        `${text.split(/\r?\n/).length.toLocaleString("en-US")} lines. COMPLETE -- nothing ` +
        "trimmed. Evaluating a candidate means opening the part that determines whether it " +
        "works. -->\n" +
        text,
      "utf8",
    )
  }

  const ids = Object.keys(selection.idMap).sort().join(", ")
  const brief = [
    selectPrompt({ n: Object.keys(rendered.pool).length, evidence: selection.evidence, profile }),
    "# YOUR EVIDENCE",
    "",
    "It is on disk. Read it -- do not answer from this message alone.",
    "",
    "```",
    "context/task.md                 the request",
    "context/source/                 task material, when supplied",
    `context/candidates/<id>.md      one file per candidate: ${ids}`,
    "```",
    "",
    `Open every candidate before choosing. Choose exactly one of: ${ids}.`,
  ].join("\n")

  assertNoGraderVerdicts(root)
  try {
    const reply = await deps.proposer.call(brief, root, `select.${deps.mode}${deps.k}`, {
      harvest: null,
    })
    selection.usd = round(selection.usd + reply.costUsd)
    const id = parseChoice(reply.text)
    if (id === null) throw new Error("no ```choice block in the reply")
    if (!(id in selection.idMap)) {
      throw new Error(`chose ${JSON.stringify(id)}, which is not one of ${ids}`)
    }
    selection.why = parseWhy(reply.text).slice(0, 2000)
    selection.chosenId = id
    selection.chosenLabel = selection.idMap[id]!
    selection.ok = true
  } catch (error) {
    if (error instanceof ProposerError) selection.usd = round(selection.usd + error.costUsd)
    if (!fallback(selection, rendered.pool, error)) return selection
  }

  const chosen = rendered.pool[selection.chosenLabel]
  if (chosen) {
    selection.chosenRunId = chosen.runId
    selection.chosenIsBase = isBaseLabel(selection.chosenLabel)
  }
  persist(selection, root)
  return selection
}

/**
 * Deliver the single k=1 final without a selector session.
 *
 * The same non-answer drop rules apply, and the record is written with the
 * standard schema at the path `runSelection` uses, so a reader finds it.
 */
export function trivialSelection(deps: Omit<SelectionDeps, "proposer">): HarnessSelection {
  const labels = Object.keys(deps.candidates)
  if (labels.length > 1) {
    throw new Error(
      `trivialSelection expects at most one candidate (the k=1 final), got ${labels.sort().join(", ")}`,
    )
  }
  const selection = emptySelection(deps.task.id, deps.mode, deps.k)
  selection.trivial = true
  const rendered = renderPool(deps.candidates, selection)
  const pool = rendered.pool
  selection.nCandidates = Object.keys(pool).length
  if (Object.keys(pool).length === 0) {
    selection.error = "no candidate produced an artifact (finals-only pool has no base fallback)"
    return selection
  }
  const label = Object.keys(pool)[0]!
  selection.ok = true
  selection.chosenId = "A"
  selection.chosenLabel = label
  selection.idMap = { A: label }
  selection.chosenRunId = pool[label]!.runId
  selection.chosenIsBase = isBaseLabel(label)
  selection.why = "trivial pool: single final at k=1; delivered without a selector session"

  const root = path.join(deps.workDir, "selection", `${deps.mode}${deps.k}`)
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  persist(selection, root)
  return selection
}

export interface ReflectionDeps {
  task: HarnessTask
  selection: HarnessSelection
  /** Every candidate rollout of the mode, finals included. */
  candidates: Record<string, HarnessRun>
  /** label -> materialised harness dir, for every stage that produced a tree. */
  harnesses: Record<string, string>
  /** The untouched base harness. */
  baseHarnessDir: string
  workDir: string
  proposer: Proposer
  profile?: HarnessProfile
  decisions?: Record<string, string>
  leakGlobs?: readonly string[]
}

/** Learn from harness edits, decisions, trajectories and deliverables after adoption. */
export async function reflectAdoption(deps: ReflectionDeps): Promise<HarnessLesson | null> {
  const profile = deps.profile ?? CODING_AGENT_PROFILE
  const chosen = deps.candidates[deps.selection.chosenLabel]
  if (!deps.selection.ok || chosen === undefined) return null

  const root = path.join(deps.workDir, "reflection", `${deps.selection.mode}${deps.selection.k}`)
  const pool = Object.entries(deps.candidates)
    .filter(([label]) => !isBaseLabel(label))
    .map(([label, run]) => ({
      label,
      harnessDir: deps.harnesses[label] ?? null,
      run,
    }))
  const evidence = buildContext({
    dest: root,
    task: deps.task,
    rollouts: Object.values(deps.candidates),
    harnessDir: deps.harnesses[deps.selection.chosenLabel] ?? null,
    pool,
    decisions: deps.decisions ?? {},
    leakGlobs: deps.leakGlobs ?? [],
  })
  copyTree(deps.baseHarnessDir, path.join(root, "base_harness"))
  fs.writeFileSync(
    path.join(root, "adoption.json"),
    `${JSON.stringify(
      {
        chosen_label: deps.selection.chosenLabel,
        candidate_ids: deps.selection.idMap,
        reason: deps.selection.why,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  assertNoGraderVerdicts(root)

  const brief = [
    experiencePrompt({ chosenLabel: deps.selection.chosenLabel, why: deps.selection.why, profile }),
    "# WHAT HAPPENED",
    "",
    `Harness ${deps.selection.chosenLabel} was adopted. The selection reasoning was:`,
    "",
    deps.selection.why || "(no reasoning was recorded)",
    "",
    "`context/adoption.json` maps any anonymous IDs in that reasoning to rollout labels. " +
      "Compare `context/harness/` with `context/base_harness/` and the candidates in " +
      "`context/pool/`. Read the decisions and execution contrasts before writing.",
    evidence.layout,
  ].join("\n\n")

  const experienceRoot = `${root}.experience`
  fs.rmSync(experienceRoot, { recursive: true, force: true })
  copyTree(root, experienceRoot)
  assertNoGraderVerdicts(experienceRoot)

  let text: string
  try {
    const reply = await deps.proposer.call(brief, experienceRoot, `experience.${deps.selection.mode}${deps.selection.k}`, {
      harvest: null,
    })
    deps.selection.usd = round(deps.selection.usd + reply.costUsd)
    text = reply.text
  } catch (error) {
    if (error instanceof ProposerError) {
      deps.selection.usd = round(deps.selection.usd + error.costUsd)
    }
    return null
  }

  const edits = parseEdits(text)
  if (edits.length > 0) {
    fs.writeFileSync(path.join(root, "edits.md"), `${edits.trim()}\n`, "utf8")
  }
  const lesson = parseLesson(text)
  if (lesson === null) return null
  assertTreeHasNoGraderVerdicts({ "EXPERIENCE.md": JSON.stringify(lesson) })

  deps.selection.experience = lesson
  persist(
    deps.selection,
    path.join(deps.workDir, "selection", `${deps.selection.mode}${deps.selection.k}`),
  )
  return lesson
}

/** The id inside the reply's ```choice block, or null when there is none. */
export function parseChoice(text: string): string | null {
  const match = /```choice\s*([\s\S]*?)```/.exec(text)
  if (!match) return null
  const id = match[1]!.trim()
  return id.length > 0 ? id : null
}

/** The reasoning inside `<why>`, or "". */
export function parseWhy(text: string): string {
  const match = /<why>([\s\S]*?)<\/why>/.exec(text)
  return match ? match[1]!.trim() : ""
}

/** The `<edits>` block, or "". */
export function parseEdits(text: string): string {
  const match = /<edits>([\s\S]*?)<\/edits>/.exec(text)
  return match ? match[1]!.trim() : ""
}

/** The `<experience>` block as a lesson, or null when it is absent or incomplete. */
export function parseLesson(text: string): HarnessLesson | null {
  const block = /<experience>([\s\S]*?)<\/experience>/.exec(text)
  if (!block) return null
  const lesson: HarnessLesson = {
    cue: "",
    lesson: "",
    evidence: "",
    confidence: "",
    edits: parseEdits(text),
  }
  for (const line of block[1]!.split(/\r?\n/)) {
    if (!line.includes(":")) continue
    const at = line.indexOf(":")
    const key = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    if (key === "cue" || key === "lesson" || key === "evidence" || key === "confidence") {
      lesson[key] = value
    }
  }
  if (lesson.cue.length === 0 || lesson.lesson.length === 0 || lesson.evidence.length === 0) {
    return null
  }
  return lesson
}

/** Whether a lesson carries the three fields that make it evidence-supported. */
export function hasSupportedLesson(lesson: HarnessLesson | null): lesson is HarnessLesson {
  return (
    lesson !== null &&
    lesson.cue.trim().length > 0 &&
    lesson.lesson.trim().length > 0 &&
    lesson.evidence.trim().length > 0
  )
}

/** Drop non-answers before anonymising, recording each drop and its cause. */
function renderPool(
  candidates: Record<string, HarnessRun>,
  selection: HarnessSelection,
): { pool: Record<string, HarnessRun>; artifacts: Record<string, string> } {
  const pool: Record<string, HarnessRun> = {}
  const artifacts: Record<string, string> = {}
  for (const [label, run] of Object.entries(candidates)) {
    if (!run.ok || !run.delivered) {
      selection.dropped.push(label)
      continue
    }
    const rendered = renderDeliverable(run)
    if (rendered.trim().length === 0) {
      selection.dropped.push(label)
      continue
    }
    pool[label] = run
    artifacts[label] = rendered
  }
  if (Object.keys(pool).length === 0 && Object.keys(candidates).length > 0) {
    for (const [label, run] of Object.entries(candidates)) {
      if (!run.ok) continue
      const body = run.transcript.trim()
      if (body.length === 0) continue
      pool[label] = run
      artifacts[label] =
        "(this task produced no file deliverable; the candidate is shown as its own session " +
        `transcript)\n\n${body}`
    }
    if (Object.keys(pool).length > 0) {
      selection.evidence = "trajectory"
      selection.dropped = selection.dropped.filter((entry) => !(entry in pool))
    }
  }
  return { pool, artifacts }
}

/** The neutral stand-in after a selector failure: a delivered base, else the first final. */
function fallback(
  selection: HarnessSelection,
  pool: Record<string, HarnessRun>,
  error: unknown,
): boolean {
  const base = Object.keys(pool).filter(isBaseLabel).sort()
  const label = base[0] ?? Object.keys(pool).sort()[0]
  if (label === undefined) {
    selection.error =
      `${describe(error).slice(0, 350)}; no delivered base artifact was available for a ` +
      "neutral fallback"
    return false
  }
  selection.chosenLabel = label
  selection.chosenId =
    Object.keys(selection.idMap).find((id) => selection.idMap[id] === label) ?? ""
  selection.fallback = true
  selection.error = describe(error).slice(0, 400)
  return true
}

function persist(selection: HarnessSelection, root: string): void {
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, "selection.json"),
      `${JSON.stringify(selection, null, 2)}\n`,
      "utf8",
    )
  } catch (error) {
    selection.ok = false
    selection.error = `${selection.error} | could not persist selection: ${describe(error)}`.slice(
      0,
      400,
    )
  }
}

function emptySelection(taskId: string, mode: HarnessMode, k: number): HarnessSelection {
  return {
    taskId,
    mode,
    k,
    chosenId: "",
    chosenLabel: "",
    chosenRunId: "",
    chosenIsBase: false,
    why: "",
    idMap: {},
    dropped: [],
    nCandidates: 0,
    ok: false,
    fallback: false,
    error: "",
    usd: 0,
    evidence: "deliverable",
    experience: null,
    trivial: false,
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** A tree's harness directory name is the stage label; export for callers that need it. */
export function harnessDirFor(workDir: string, label: string): string {
  return path.join(workDir, "harnesses", label)
}

/** The safe on-disk directory name for a task id. */
export function taskSlug(taskId: string): string {
  return safeName(taskId.replace(/[/\\]/g, "__"))
}
