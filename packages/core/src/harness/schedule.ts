/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Namespacing, the seeded stream order, and the drivers: one task, one
 * area, a sweep.
 *
 * `ns()` is the only function that builds a run namespace; `Namespace` is
 * the only thing that globs over one. Scheme:
 * `<agent>-<surface>-<mode><k>[-s<seed>][-<tag>]`.
 *
 * The task driver runs the k shared reference executions once, then every
 * mode over them, then a blind selection per mode, then writes a summary
 * that a later run can resume from. The area driver threads the experience
 * library forward, task by task.
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
  HarnessModeResult,
  HarnessRun,
  HarnessSelection,
} from "./types.js"
import type { HarnessTask, RolloutPort } from "./ports.js"
import { mapLimit } from "./ports.js"
import type { SurfaceSpec } from "./tree.js"
import { readTree } from "./tree.js"
import type { HarnessProfile } from "./types.js"
import { Proposer } from "./proposer.js"
import {
  reflectAdoption,
  runSelection,
  selectionPool,
  trivialSelection,
} from "./selection.js"
import { runMode } from "./recursion.js"
import { HarnessLibrary, hasExperience, slug } from "./library.js"
import { finishSummary, readJsonFile } from "./summary.js"
import { markComplete } from "./runmark.js"

export const MODES: readonly HarnessMode[] = ["agg", "seq"]

const MODE_ALIASES: Record<string, HarnessMode> = {
  agg: "agg",
  seq: "seq",
  parallel: "agg",
  sequential: "seq",
}

/** The on-disk token for a mode name: parallel/agg -> "agg", sequential/seq -> "seq". */
export function modeToken(name: string): HarnessMode {
  const key = name.trim().toLowerCase()
  const mode = MODE_ALIASES[key]
  if (!mode) {
    throw new Error(
      `unknown mode ${JSON.stringify(name)}; expected parallel | sequential (or the on-disk tokens agg | seq)`,
    )
  }
  return mode
}

/** Check a tag's shape: it becomes a path segment and must not spell a seed segment. */
export function validateTag(tag: string): void {
  if (tag.length === 0) return
  if (!/^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(tag)) {
    throw new Error(
      `tag ${JSON.stringify(tag)} must be [A-Za-z0-9_.-] with no leading '-' and no '/': it ` +
        "becomes a path segment and a run-id segment",
    )
  }
  if (/^s\d+(-|$)/.test(tag)) {
    throw new Error(
      `tag ${JSON.stringify(tag)} spells a seed segment; pass a seed instead so seeded and ` +
        "tagged namespaces can never collide",
    )
  }
}

/** Every name for one (agent, surface, mode, k, seed, tag) setting. */
export class Namespace {
  readonly agent: string
  readonly surface: string
  readonly mode: HarnessMode
  readonly k: number
  readonly seed: number | null
  readonly tag: string

  constructor(input: {
    agent: string
    surface: string
    mode: HarnessMode
    k: number
    seed?: number | null
    tag?: string
  }) {
    this.agent = input.agent
    this.surface = input.surface
    this.mode = input.mode
    this.k = input.k
    this.seed = input.seed ?? null
    this.tag = input.tag ?? ""
  }

  toString(): string {
    return ns({
      agent: this.agent,
      surface: this.surface,
      mode: this.mode,
      k: this.k,
      seed: this.seed,
      tag: this.tag,
    })
  }

  runId(taskId: string, label: string): string {
    return `${this.toString()}/${taskId}/${label}`
  }

  taskDir(root: string, taskId: string): string {
    return path.join(root, this.toString(), slug(taskId))
  }

  /** The only glob over namespaces; matches seeded, tagged and bare forms. */
  static glob(input: {
    agent: string
    surface: string
    k: number
    mode?: HarnessMode | "*"
  }): { base: string; pattern: string } {
    const base = `${input.agent}-${input.surface}-${input.mode ?? "*"}${Math.trunc(input.k)}`
    return { base, pattern: `${base}-*` }
  }
}

/** Build the namespace token. */
export function ns(input: {
  agent: string
  surface: string
  mode: HarnessMode
  k: number
  seed?: number | null
  tag?: string
}): string {
  if (!MODES.includes(input.mode)) {
    throw new Error(
      `unknown mode ${JSON.stringify(input.mode)}; the method has exactly two: ${MODES.join(", ")}`,
    )
  }
  if (input.surface.trim().length === 0) {
    throw new Error(
      "namespace needs a surface name; an empty one would let two surfaces' caches collide on " +
        "every label",
    )
  }
  validateTag(input.tag ?? "")
  let out = `${input.agent}-${input.surface}-${input.mode}${Math.trunc(input.k)}`
  if (input.seed !== undefined && input.seed !== null) out += `-s${Math.trunc(input.seed)}`
  if ((input.tag ?? "").length > 0) out += `-${input.tag}`
  return out
}

/**
 * The full (area, task) stream: the one constructor of continual-learning order.
 *
 * `seed: null` is the reference order: the supplied area order, tasks sorted.
 * An integer seed shuffles areas then each area's tasks. Each shuffle starts
 * from the sorted order, so the result depends only on (seed, area, task set)
 * -- never on object iteration order or which other areas are present.
 */
export function streamOrder(
  tasksByArea: Readonly<Record<string, readonly string[]>>,
  seed: number | null,
  referenceAreaOrder: readonly string[],
): Array<{ area: string; taskId: string }> {
  const areas = Object.keys(tasksByArea).sort()
  let ordered: string[]
  if (seed === null) {
    const missing = areas.filter((area) => !referenceAreaOrder.includes(area))
    if (missing.length > 0) {
      throw new Error(
        `referenceAreaOrder does not cover area(s) ${missing.join(", ")}; the frozen order ` +
          "is stale -- regenerate it rather than letting an unlisted area land anywhere",
      )
    }
    ordered = referenceAreaOrder.filter((area) => area in tasksByArea)
  } else {
    ordered = [...areas]
    seededShuffle(ordered, `${seed}:__areas__`)
  }
  const out: Array<{ area: string; taskId: string }> = []
  for (const area of ordered) {
    const tasks = [...(tasksByArea[area] ?? [])].sort()
    if (seed !== null) seededShuffle(tasks, `${seed}:${area}`)
    for (const taskId of tasks) out.push({ area, taskId })
  }
  return out
}

/** Descending task count, then name. */
export function defaultReferenceAreaOrder(
  byArea: Readonly<Record<string, readonly string[]>>,
): string[] {
  return Object.keys(byArea).sort((a, b) => {
    const delta = (byArea[b]?.length ?? 0) - (byArea[a]?.length ?? 0)
    return delta !== 0 ? delta : a.localeCompare(b)
  })
}

export interface TaskDeps {
  task: HarnessTask
  surface: SurfaceSpec
  profile?: HarnessProfile
  /** The untouched base harness on disk; the start of every mode. */
  baseHarnessDir: string
  proposer: Proposer
  /** The blind selector's sessions. Defaults to `proposer`. */
  selector?: Proposer
  rollout: RolloutPort
  runsRoot: string
  modes?: readonly HarnessMode[]
  seed?: number | null
  tag?: string
  library?: HarnessLibrary | null
  libraries?: Partial<Record<HarnessMode, HarnessLibrary>>
  proposeWorkers?: number
  rolloutWorkers?: number
  leakGlobs?: readonly string[]
  log?: (line: string) => void
}

export interface TaskResult {
  taskId: string
  domain: string
  k: number
  seed: number | null
  status: "running" | "ok" | "partial" | "skipped" | "base-failed"
  base: Array<{ label: string; runId: string; runDir: string }>
  modes: Partial<Record<HarnessMode, HarnessModeResult>>
  selections: Partial<Record<HarnessMode, HarnessSelection>>
  errors: string[]
}

/**
 * k shared reference executions -> every mode -> blind selection per mode
 * -> summary.json.
 */
export async function runTask(task: HarnessTask, k: number, deps: TaskDeps): Promise<TaskResult> {
  if (k < 1) throw new Error(`k must be positive, got ${k}`)
  const modes = [...(deps.modes ?? MODES)]
  if (modes.length === 0 || new Set(modes).size !== modes.length) {
    throw new Error("modes must contain at least one distinct recursion mode")
  }
  const unknown = modes.filter((mode) => !MODES.includes(mode))
  if (unknown.length > 0) {
    throw new Error(`unknown modes ${unknown.join(", ")}; expected a subset of ${MODES.join(", ")}`)
  }
  const libraries = resolveLibraries(deps.library ?? null, deps.libraries ?? {}, modes)
  const selectorProposer = deps.selector ?? deps.proposer
  const log = deps.log ?? (() => {})

  const baseNamespace = new Namespace({
    agent: deps.surface.name,
    surface: deps.surface.name,
    mode: "agg",
    k,
    seed: deps.seed ?? null,
    tag: deps.tag ?? "",
  })
  const work = baseNamespace.taskDir(deps.runsRoot, task.id)
  fs.mkdirSync(work, { recursive: true })
  const summaryPath = path.join(work, "summary.json")

  const result: TaskResult = {
    taskId: task.id,
    domain: task.domain,
    k,
    seed: deps.seed ?? null,
    status: "running",
    base: [],
    modes: {},
    selections: {},
    errors: [],
  }

  if (fs.existsSync(summaryPath)) {
    const resumed = resumeSummary({ path: summaryPath, task, k, deps, modes, libraries, result })
    if (resumed) return result
  }

  const baseTree = readTree(deps.surface, deps.baseHarnessDir)
  if (Object.keys(baseTree).length === 0) {
    result.status = "base-failed"
    result.errors.push(`the base harness at ${deps.baseHarnessDir} is empty`)
    writeSummary(summaryPath, result)
    return result
  }

  const labels = Array.from({ length: k }, (_, index) => `base${index + 1}`)
  const bases = await mapLimit(labels, deps.rolloutWorkers ?? Math.min(4, k), (label) =>
    rollBase({ deps, task, work, label, runId: baseNamespace.runId(task.id, label) }),
  )
  result.base = bases.map((run) => ({
    label: run.label,
    runId: run.runId,
    runDir: run.runDir,
  }))
  if (!bases.some((run) => run.ok)) {
    result.status = "base-failed"
    result.errors.push("no base rollout produced anything")
    writeSummary(summaryPath, result)
    return result
  }

  for (const mode of modes) {
    const namespace = new Namespace({
      agent: deps.surface.name,
      surface: deps.surface.name,
      mode,
      k,
      seed: deps.seed ?? null,
      tag: deps.tag ?? "",
    })
    try {
      const modeResult = await runMode(mode, k, {
        task,
        surface: deps.surface,
        profile: deps.profile,
        proposer: deps.proposer,
        rollout: deps.rollout,
        workDir: namespace.taskDir(deps.runsRoot, task.id),
        baseRuns: bases,
        baseTree,
        libraryDir: libraries[mode]?.contextDir() ?? null,
        runIdOf: (label) => namespace.runId(task.id, label),
        proposeWorkers: deps.proposeWorkers,
        rolloutWorkers: deps.rolloutWorkers,
        leakGlobs: deps.leakGlobs,
        log,
      })
      result.modes[mode] = modeResult
      const candidates = selectionPool(mode, k, modeResult.rollouts)
      const selection =
        k === 1
          ? trivialSelection({
              task,
              mode,
              k,
              candidates,
              workDir: namespace.taskDir(deps.runsRoot, task.id),
              profile: deps.profile,
              leakGlobs: deps.leakGlobs,
            })
          : await runSelection({
              task,
              mode,
              k,
              candidates,
              workDir: namespace.taskDir(deps.runsRoot, task.id),
              proposer: selectorProposer,
              profile: deps.profile,
              leakGlobs: deps.leakGlobs,
            })

      const harnesses: Record<string, string> = {}
      for (const label of Object.keys(modeResult.trees)) {
        harnesses[label] = path.join(
          namespace.taskDir(deps.runsRoot, task.id),
          "harnesses",
          label,
        )
      }
      const library = libraries[mode]
      if (library) {
        await reflectAdoption({
          task,
          selection,
          candidates: modeResult.rollouts,
          harnesses,
          baseHarnessDir: deps.baseHarnessDir,
          workDir: namespace.taskDir(deps.runsRoot, task.id),
          proposer: selectorProposer,
          profile: deps.profile,
          decisions: Object.fromEntries(
            modeResult.stages.map((stage) => [stage.label, stage.notes || stage.error]),
          ),
          leakGlobs: deps.leakGlobs,
        })
      }
      const chosenTree = modeResult.trees[selection.chosenLabel] ?? baseTree
      if (selection.ok && library && hasExperience(selection.experience)) {
        library.add({
          taskId: task.id,
          harness: chosenTree,
          why: selection.why,
          label: selection.chosenLabel,
          runId: selection.chosenRunId,
          experience: selection.experience,
        })
      }
      if (!selection.ok) {
        result.errors.push(`${mode}: selection failed: ${selection.error}`)
      }
      result.selections[mode] = selection
    } catch (error) {
      result.errors.push(`${mode}: ${describe(error)}`)
    }
    result.status = "partial"
    writeSummary(summaryPath, result)
  }

  result.status = mergedStatus(result)
  writeSummary(summaryPath, result)
  return result
}

export interface DomainDeps extends Omit<TaskDeps, "task" | "libraries"> {
  /** The root under which `<mode>/<area>/` libraries live. */
  libraryRoot: string
}

/** Every task in one area, in stream order, threading the library forward. */
export async function runDomain(
  area: string,
  tasks: readonly HarnessTask[],
  k: number,
  deps: DomainDeps,
): Promise<{
  area: string
  nTasks: number
  seed: number | null
  done: number
  failed: number
  tasks: Array<{ taskId: string; status: string; error?: string; libraryEntriesBefore: Record<string, number> }>
}> {
  const modes = [...(deps.modes ?? MODES)]
  const libraries: Partial<Record<HarnessMode, HarnessLibrary>> = {}
  for (const mode of modes) {
    libraries[mode] = new HarnessLibrary({
      root: path.join(deps.libraryRoot, mode),
      domain: area,
      surface: deps.surface,
    })
  }
  const out = {
    area,
    nTasks: tasks.length,
    seed: deps.seed ?? null,
    done: 0,
    failed: 0,
    tasks: [] as Array<{
      taskId: string
      status: string
      error?: string
      libraryEntriesBefore: Record<string, number>
    }>,
  }
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index]!
    const before: Record<string, number> = {}
    for (const mode of modes) {
      const library = libraries[mode]!
      library.retain(tasks.slice(0, index).map((entry) => entry.id))
      before[mode] = library.entries().length
    }
    try {
      const { libraryRoot: _libraryRoot, ...taskDeps } = deps
      void _libraryRoot
      const result = await runTask(task, k, { ...taskDeps, task, libraries })
      const ok = result.status === "ok" || result.status === "skipped"
      if (ok) out.done++
      else out.failed++
      out.tasks.push({
        taskId: task.id,
        status: result.status,
        ...(ok ? {} : { error: result.errors.join("; ") || result.status }),
        libraryEntriesBefore: before,
      })
    } catch (error) {
      out.failed++
      out.tasks.push({
        taskId: task.id,
        status: "exception",
        error: describe(error),
        libraryEntriesBefore: before,
      })
    }
    const row = out.tasks[out.tasks.length - 1]!
    deps.log?.(
      `  [${area}] ${index + 1}/${tasks.length} ${row.status.padEnd(12)} ${task.id}` +
        (row.error ? `  :: ${row.error}` : ""),
    )
  }
  return out
}

export interface SweepDeps extends DomainDeps {
  tasksByArea: Readonly<Record<string, readonly string[]>>
  taskOf: (taskId: string) => HarnessTask
  onlyAreas?: readonly string[]
  onlyTasks?: readonly string[]
  maxTasks?: number
  areaParallel?: number
}

/** Resolve the ordered task stream, then run every area. */
export async function runSweep(k: number, deps: SweepDeps): Promise<{
  k: number
  seed: number | null
  areas: string[]
  done: number
  failed: number
  results: Array<{ area: string; tasks: number; done: number; failed: number }>
}> {
  const byArea = taskStream(deps.tasksByArea, {
    seed: deps.seed ?? null,
    onlyAreas: deps.onlyAreas,
    onlyTasks: deps.onlyTasks,
    maxTasks: deps.maxTasks,
  })
  const areas = Object.keys(byArea).sort()
  const results = await mapLimit(areas, deps.areaParallel ?? 1, async (area) => {
    const tasks = byArea[area]!.map((taskId) => deps.taskOf(taskId))
    const report = await runDomain(area, tasks, k, deps)
    return {
      area,
      tasks: report.nTasks,
      done: report.done,
      failed: report.failed,
    }
  })
  return {
    k,
    seed: deps.seed ?? null,
    areas,
    done: results.reduce((acc, row) => acc + row.done, 0),
    failed: results.reduce((acc, row) => acc + row.failed, 0),
    results,
  }
}

/** Apply the stream filters while preserving the seeded order. */
export function taskStream(
  tasksByArea: Readonly<Record<string, readonly string[]>>,
  input: {
    seed?: number | null
    onlyAreas?: readonly string[]
    onlyTasks?: readonly string[]
    maxTasks?: number
    referenceAreaOrder?: readonly string[]
  } = {},
): Record<string, string[]> {
  let filtered: Record<string, string[]> = {}
  for (const [area, tasks] of Object.entries(tasksByArea)) filtered[area] = [...tasks]
  const onlyAreas = input.onlyAreas ?? []
  if (onlyAreas.length > 0) {
    const keep = new Set(onlyAreas)
    const missing = [...keep].filter((area) => !(area in filtered)).sort()
    if (missing.length > 0) {
      throw new Error(
        `onlyAreas names unknown area(s) ${missing.join(", ")}; known: ${Object.keys(filtered).sort().join(", ")}`,
      )
    }
    filtered = Object.fromEntries(Object.entries(filtered).filter(([area]) => keep.has(area)))
  }
  const onlyTasks = input.onlyTasks ?? []
  if (onlyTasks.length > 0) {
    const wanted = new Set(onlyTasks)
    const known = new Set(Object.values(filtered).flat())
    const missing = [...wanted].filter((taskId) => !known.has(taskId)).sort()
    if (missing.length > 0) {
      throw new Error(
        `onlyTasks names unknown task id(s) ${missing.join(", ")}` +
          (onlyAreas.length > 0 ? ` / areas ${Object.keys(filtered).sort().join(", ")}` : ""),
      )
    }
  }
  if (input.maxTasks !== undefined && input.maxTasks < 1) {
    throw new Error(`maxTasks must be positive, got ${input.maxTasks}`)
  }
  const stream = streamOrder(
    filtered,
    input.seed ?? null,
    input.referenceAreaOrder ?? defaultReferenceAreaOrder(filtered),
  )
  const ordered: Record<string, string[]> = {}
  for (const entry of stream) {
    if (onlyTasks.length > 0 && !onlyTasks.includes(entry.taskId)) continue
    const bucket = ordered[entry.area] ?? []
    if (input.maxTasks !== undefined && bucket.length >= input.maxTasks) continue
    bucket.push(entry.taskId)
    ordered[entry.area] = bucket
  }
  return ordered
}

interface ResumeInput {
  path: string
  task: HarnessTask
  k: number
  deps: TaskDeps
  modes: readonly HarnessMode[]
  libraries: Partial<Record<HarnessMode, HarnessLibrary>>
  result: TaskResult
}

/** Fill `result` from a cached summary covering every requested mode; true if it did. */
function resumeSummary(input: ResumeInput): boolean {
  const cached = readJsonFile(input.path)
  if (cached === null || cached.status !== "ok") return false
  const cachedModes = asRecord(cached.modes)
  const cachedSelections = asRecord(cached.selections)
  const missing = input.modes.filter((mode) => {
    const modeRecord = asRecord(cachedModes[mode])
    const selection = asRecord(cachedSelections[mode])
    return !(modeRecord.ok === true && selection.ok === true && chosenLabel(selection).length > 0)
  })
  if (missing.length > 0) {
    input.deps.log?.(
      `  [${input.task.id}] cached summary covers ${Object.keys(cachedModes).sort().join(", ")}, ` +
        `re-running for ${missing.join(", ")}`,
    )
    return false
  }

  for (const mode of input.modes) {
    const selection = asRecord(cachedSelections[mode])
    const namespace = new Namespace({
      agent: input.deps.surface.name,
      surface: input.deps.surface.name,
      mode,
      k: input.k,
      seed: input.deps.seed ?? null,
      tag: input.deps.tag ?? "",
    })
    const label = chosenLabel(selection)
    const taskDir = namespace.taskDir(input.deps.runsRoot, input.task.id)
    const harnessDir = path.join(taskDir, "harnesses", label)
    const runDir = path.join(taskDir, "runs", label)
    if (!fs.existsSync(runDir)) {
      input.deps.log?.(`  [${input.task.id}] cannot resume ${mode}: adopted run directory is missing; re-running`)
      return false
    }
    if (label.length === 0 || !fs.existsSync(harnessDir)) {
      input.deps.log?.(`  [${input.task.id}] cannot resume ${mode}: adopted harness is missing; re-running`)
      return false
    }
  }

  input.result.status = "skipped"
  input.result.base = Array.isArray(cached.base)
    ? (cached.base as Array<{ label: string; runId: string; runDir: string }>)
    : []
  input.result.modes = cachedModes as Partial<Record<HarnessMode, HarnessModeResult>>
  input.result.selections = cachedSelections as Partial<Record<HarnessMode, HarnessSelection>>
  input.result.errors = Array.isArray(cached.errors) ? (cached.errors as string[]) : []
  restoreLibraries(input)
  return true
}

/** Replay a skipped task into its libraries from the saved chosen harness. */
function restoreLibraries(input: ResumeInput): void {
  for (const mode of input.modes) {
    const library = input.libraries[mode]
    const selection = asRecord(input.result.selections[mode])
    const label = chosenLabel(selection)
    if (
      !library ||
      label.length === 0 ||
      selection.ok !== true ||
      !hasExperience((selection.experience ?? null) as HarnessLesson | null)
    ) {
      continue
    }
    const namespace = new Namespace({
      agent: input.deps.surface.name,
      surface: input.deps.surface.name,
      mode,
      k: input.k,
      seed: input.deps.seed ?? null,
      tag: input.deps.tag ?? "",
    })
    const tree = readTree(
      input.deps.surface,
      path.join(namespace.taskDir(input.deps.runsRoot, input.task.id), "harnesses", label),
    )
    if (Object.keys(tree).length === 0) continue
    library.add({
      taskId: input.task.id,
      harness: tree,
      why: String(selection.why ?? ""),
      label,
      runId: String(selection.chosenRunId ?? selection.chosen_run_id ?? ""),
      experience: selection.experience as HarnessSelection["experience"],
    })
  }
}

/** The chosen label, under either casing the port has written. */
function chosenLabel(selection: Record<string, unknown>): string {
  const value = selection.chosenLabel ?? selection.chosen_label
  return typeof value === "string" ? value : ""
}

async function rollBase(input: {
  deps: TaskDeps
  task: HarnessTask
  work: string
  label: string
  runId: string
}): Promise<HarnessRun> {
  const runDir = path.join(input.work, "runs", input.label)
  fs.mkdirSync(runDir, { recursive: true })
  try {
    const run = await input.deps.rollout.run({
      task: input.task,
      label: input.label,
      runId: input.runId,
      harnessDir: null,
      runDir,
    })
    const normalized: HarnessRun = {
      ...run,
      label: input.label,
      runId: input.runId,
      runDir: run.runDir || runDir,
      costUsd: Number.isFinite(run.costUsd) ? run.costUsd : 0,
      wallS: Number.isFinite(run.wallS) ? run.wallS : 0,
    }
    if (normalized.ok) markComplete(runDir, { runId: input.runId, harnessDir: null })
    return normalized
  } catch (error) {
    return {
      label: input.label,
      runId: input.runId,
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

function resolveLibraries(
  library: HarnessLibrary | null,
  libraries: Partial<Record<HarnessMode, HarnessLibrary>>,
  modes: readonly HarnessMode[],
): Partial<Record<HarnessMode, HarnessLibrary>> {
  const out = { ...libraries }
  if (library === null) return out
  if (Object.keys(out).length > 0) {
    throw new Error("pass either library or libraries, not both")
  }
  if (modes.length !== 1) {
    throw new Error(
      "a shared mutable library would leak one mode into another; pass libraries={agg, seq} instead",
    )
  }
  out[modes[0]!] = library
  return out
}

/** The summary path for one task namespace. */
export function summaryPathFor(input: {
  runsRoot: string
  surfaceName: string
  taskId: string
  k: number
  seed?: number | null
  tag?: string
}): string {
  const namespace = new Namespace({
    agent: input.surfaceName,
    surface: input.surfaceName,
    mode: "agg",
    k: input.k,
    seed: input.seed ?? null,
    tag: input.tag ?? "",
  })
  return path.join(namespace.taskDir(input.runsRoot, input.taskId), "summary.json")
}

/** Write the summary atomically, merging per-mode records written by earlier attempts. */
export function writeSummary(summaryPath: string, result: TaskResult): void {
  const merged = toSummary(result)
  const old = readJsonFile(summaryPath)
  if (old !== null) {
    const modes = { ...asRecord(old.modes), ...asRecord(merged.modes) }
    const selections = { ...asRecord(old.selections), ...asRecord(merged.selections) }
    const errors = [...new Set([...(asStringArray(old.errors)), ...merged.errors])]
    merged.modes = modes
    merged.selections = selections
    merged.errors = errors
    if (Array.isArray(old.base) && merged.base.length === 0) {
      merged.base = old.base as Array<{ label: string; runId: string; runDir: string }>
    }
  }
  if (merged.status === "ok" || merged.status === "partial") {
    merged.status = finishSummary(merged)
  }
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  const tmp = `${summaryPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
  fs.renameSync(tmp, summaryPath)
}

function toSummary(result: TaskResult): {
  task_id: string
  domain: string
  k: number
  seed: number | null
  status: string
  base: Array<{ label: string; runId: string; runDir: string }>
  modes: Record<string, unknown>
  selections: Record<string, unknown>
  errors: string[]
} {
  return {
    task_id: result.taskId,
    domain: result.domain,
    k: result.k,
    seed: result.seed,
    status: result.status,
    base: result.base,
    modes: result.modes,
    selections: result.selections,
    errors: [...result.errors],
  }
}

function mergedStatus(result: TaskResult): TaskResult["status"] {
  const modes = Object.values(result.modes)
  if (modes.length === 0) return "partial"
  const ok =
    result.errors.length === 0 &&
    modes.every((mode) => mode?.ok === true) &&
    Object.values(result.selections).every(
      (selection) => selection?.ok === true && selection.chosenLabel.length > 0,
    )
  return ok ? "ok" : "partial"
}

function seededShuffle<T>(items: T[], key: string): void {
  const seed = parseInt(createHash("sha1").update(key).digest("hex").slice(0, 12), 16)
  let state = seed >>> 0
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const tmp = items[i]!
    items[i] = items[j]!
    items[j] = tmp
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
