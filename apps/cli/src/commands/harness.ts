/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import {
  CODING_AGENT_PROFILE,
  HarnessLibrary,
  Proposer,
  NEMO_SURFACE,
  baseHarness,
  hasExperience,
  inventory,
  modeToken,
  readTree,
  skillNames,
  summaryPathFor,
  validate,
  writeTree,
  type HarnessLedgerSummary,
  type HarnessMode,
  type HarnessSelection,
  type HarnessTask,
  type HarnessTree,
  type SurfaceSpec,
} from "../../../../packages/core/src/harness/index.js"
import { runTask } from "../../../../packages/core/src/harness/schedule.js"
import { loadConfig } from "../../../runtime/src/config.js"
import { createNemoHarnessPorts } from "../../../runtime/src/agent/harness-ports.js"
import { autoUpdateSelf } from "../../../runtime/src/update/self-update.js"

/** The actions the command supports. */
export type HarnessAction = "show" | "init" | "run" | "lessons" | "apply" | "auto"

export interface HarnessCommandInput {
  action: HarnessAction
  /** The task for `run`, the task id for `apply`, the task file for `auto`. */
  task?: string
  /** The recursion budget for `run`. */
  k?: number
  /** `parallel` (width) or `sequential` (depth). */
  mode?: "parallel" | "sequential"
  /** The area the lessons are filed under. */
  domain?: string
  /** Reproducible stream/run seed. */
  seed?: number
  /** A namespace tag, for reusing a run namespace deliberately. */
  tag?: string
  /** The repository a rollout starts from. Omitted = an empty workspace. */
  sourceDir?: string
}

/** Where the active harness, the runs and the lesson libraries live. */
export interface HarnessPaths {
  /** `~/.nemo/harness`. */
  root: string
  /** The active harness tree. */
  active: string
  /** `<root>/library`; each mode and area is a directory under it. */
  libraryRoot: string
  /** `<root>/runs`; one namespace directory per run. */
  runsRoot: string
  /** `<root>/audit`; every improver session's mission and reply. */
  auditDir: string
}

export function harnessPaths(_domain: string, home: string = homedir()): HarnessPaths {
  const root = join(home, ".nemo", "harness")
  return {
    root,
    active: root,
    libraryRoot: join(root, "library"),
    runsRoot: join(root, "runs"),
    auditDir: join(root, "audit"),
  }
}

/** The active harness tree, or the base one when nothing was saved yet. */
export function loadActiveHarness(home: string = homedir()): HarnessTree {
  const dir = harnessPaths("default", home).active
  if (!existsSync(dir)) return baseHarness(CODING_AGENT_PROFILE)
  const tree = readTree(NEMO_SURFACE, dir)
  return Object.keys(tree).length > 0 ? tree : baseHarness(CODING_AGENT_PROFILE)
}

/**
 * Save a harness as the active one.
 *
 * The tree is validated first: a harness that would be rejected when a
 * candidate proposes it must not become the thing every task starts from.
 */
export function saveActiveHarness(tree: HarnessTree, home: string = homedir()): string {
  validate(NEMO_SURFACE, tree, { profile: CODING_AGENT_PROFILE })
  const dir = harnessPaths("default", home).active
  for (const rel of Object.keys(readTree(NEMO_SURFACE, dir))) {
    rmSync(join(dir, rel), { force: true })
  }
  writeTree(NEMO_SURFACE, tree, dir)
  return dir
}

/** The component kind for one relative path. */
function componentKind(surface: SurfaceSpec, rel: string): string {
  if (surface.alwaysOn.includes(rel)) {
    if (rel === surface.alwaysOn[0]) return "systemPrompt"
    return rel.replace(/\.md$/, "")
  }
  if (rel.startsWith(`${surface.skillDir}/`)) return "skill"
  if (rel.startsWith(`${surface.subagentDir}/`)) return "subagent"
  if (rel.startsWith(`${surface.scriptDir}/`)) return "script"
  if (surface.pluginDir !== null && rel.startsWith(`${surface.pluginDir}/`)) return "plugin"
  return "other"
}

/** A readable dump of a harness. */
export function formatHarness(tree: HarnessTree, surface: SurfaceSpec = NEMO_SURFACE): string {
  const lines = [`Harness — ${inventory(surface, tree)}`, ""]
  let census: ReturnType<typeof validate> | null = null
  let error = ""
  try {
    census = validate(surface, tree, { profile: CODING_AGENT_PROFILE })
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  }
  if (census) {
    lines.push(`${census.nFiles} files · ${census.alwaysOnChars} always-on chars`)
    lines.push(
      `${census.skills} skills · ${census.subagents} subagents · ${census.scripts} scripts · ${census.plugins} plugins`,
    )
  } else if (error.length > 0) {
    lines.push(`INVALID: ${error}`)
  }
  lines.push("")
  for (const rel of Object.keys(tree).sort()) {
    lines.push(`${componentKind(surface, rel).padEnd(14)} ${rel}`)
  }
  const skills = skillNames(surface, tree)
  if (skills.length > 0) {
    lines.push("")
    lines.push("Skills:")
    for (const name of skills) lines.push(`  - ${name}`)
  }
  return lines.join("\n")
}

/** The library index for an area, rendered for the terminal. */
export function formatLibrary(domain: string, home: string = homedir()): string {
  const { libraryRoot } = harnessPaths(domain, home)
  const chunks: string[] = []
  for (const mode of ["agg", "seq"] as const) {
    const index = join(libraryRoot, mode, domain, "INDEX.md")
    if (!existsSync(index)) continue
    chunks.push(`# ${mode === "agg" ? "parallel" : "sequential"} (${mode})`, "", readFileSync(index, "utf8").trim())
  }
  if (chunks.length === 0) {
    return (
      `No lessons yet for "${domain}".\n` +
      "Run /harness run <task> to create the first one; a lesson is only filed when the " +
      "adoption carried evidence."
    )
  }
  return chunks.join("\n\n")
}

/** Every stored harness for a task id, newest first. */
interface StoredHarness {
  mode: string
  domain: string
  dir: string
  at: number
}

function storedHarnesses(taskId: string, home: string): StoredHarness[] {
  const { libraryRoot } = harnessPaths("default", home)
  if (!existsSync(libraryRoot)) return []
  const slug = taskId.replace(/[/\\]/g, "__")
  const found: StoredHarness[] = []
  for (const mode of readdirSync(libraryRoot)) {
    const modeDir = join(libraryRoot, mode)
    if (!isDirectory(modeDir)) continue
    for (const domain of readdirSync(modeDir)) {
      const dir = join(modeDir, domain, "harnesses", slug, "harness")
      if (!isDirectory(dir)) continue
      found.push({ mode, domain, dir, at: modifiedAt(dir) })
    }
  }
  return found.sort((a, b) => b.at - a.at)
}

/** Print the ledger, the selection and the lesson a run produced. */
function describeRun(input: {
  mode: HarnessMode
  k: number
  domain: string
  taskId: string
  ledger: HarnessLedgerSummary | null
  selection: HarnessSelection | null
  fellBack: string[]
  keptBase: string[]
  stages: number
  errors: string[]
  summaryPath: string
}): string {
  const lines = [
    `Harness ${input.mode === "agg" ? "parallel" : "sequential"} run — k=${input.k}  domain=${input.domain}`,
    `task: ${input.taskId}`,
    `stages: ${input.stages}  fell back: ${input.fellBack.length}  kept the base: ${input.keptBase.length}`,
  ]
  if (input.ledger) {
    lines.push(
      `rollouts: ${input.ledger.rollouts}/${input.ledger.expectedRollouts}  ` +
        `sessions: ${input.ledger.sessions}/${input.ledger.expectedSessions}  ` +
        `attempts: ${input.ledger.sessionAttempts}  usd: $${input.ledger.usd.toFixed(4)}`,
    )
  }
  const selection = input.selection
  if (selection) {
    if (selection.fallback) {
      lines.push(`The selector failed (${selection.error}); fell back to ${selection.chosenLabel}.`)
    } else if (selection.trivial) {
      lines.push(`Chosen: ${selection.chosenLabel} (the only final at k=1).`)
    } else {
      lines.push(`Chosen: ${selection.chosenLabel}`)
      lines.push(selection.why || "(no reasoning returned)")
    }
    const lesson = selection.experience
    if (lesson) {
      lines.push("", "Lesson filed:", `  cue:      ${lesson.cue}`, `  lesson:   ${lesson.lesson}`)
      if (lesson.confidence) lines.push(`  confidence: ${lesson.confidence}`)
    } else {
      lines.push("", "No lesson filed: the adoption carried no evidence a later task could use.")
    }
  }
  if (input.errors.length > 0) {
    lines.push("", "Errors:")
    for (const error of input.errors) lines.push(`  - ${error}`)
  }
  lines.push("", `runs: ${input.summaryPath}`)
  return lines.join("\n")
}

/**
 * Run the command.
 *
 * `run` is the autonomous part: it proposes harness edits, rolls them out
 * against the task, composes a refined harness, picks a winner blind and
 * files the lesson for the next task in the area.
 */
export async function harnessCommand(input: HarnessCommandInput): Promise<string> {
  switch (input.action) {
    case "show": {
      return formatHarness(loadActiveHarness())
    }
    case "init": {
      const tree = baseHarness(CODING_AGENT_PROFILE)
      validate(NEMO_SURFACE, tree, { profile: CODING_AGENT_PROFILE })
      const dir = saveActiveHarness(tree)
      return `Harness initialised at ${dir}\n\n${formatHarness(tree)}`
    }
    case "lessons": {
      return formatLibrary(input.domain ?? "default")
    }
    case "apply": {
      const taskId = input.task?.trim()
      if (!taskId) return "Usage: /harness apply <task-id>"
      const stored = storedHarnesses(taskId, homedir())
      if (stored.length === 0) {
        return `No stored harness for "${taskId}". Run /harness lessons to see what is stored.`
      }
      const pick = stored[0]!
      const tree = readTree(NEMO_SURFACE, pick.dir)
      if (Object.keys(tree).length === 0) return `The stored harness for "${taskId}" is empty.`
      try {
        validate(NEMO_SURFACE, tree, { profile: CODING_AGENT_PROFILE })
      } catch (error) {
        return `The stored harness for "${taskId}" does not validate:\n${describe(error)}`
      }
      const saved = saveActiveHarness(tree)
      return (
        `Adopted the harness from "${taskId}" (${pick.mode}/${pick.domain}).\n` +
        `Saved to ${saved}\n\n${formatHarness(tree)}`
      )
    }
    case "run": {
      const request = input.task?.trim()
      if (!request) {
        return "Usage: /harness run <task> [--k N] [--mode parallel|sequential] [--domain D] [--source DIR]"
      }
      return executeHarnessRun({
        request,
        domain: (input.domain ?? "default").trim() || "default",
        k: Math.min(4, Math.max(1, input.k ?? 1)),
        mode: modeToken(input.mode ?? "parallel"),
        seed: input.seed ?? null,
        tag: input.tag ?? "",
        ...(input.sourceDir ? { sourceDir: input.sourceDir } : {}),
        adopt: false,
      })
    }
    case "auto": {
      return runAutoTask(input.task?.trim())
    }
    default:
      return "Usage: /harness [show|init|run|lessons|apply]"
  }
}

interface HarnessRunInput {
  request: string
  domain: string
  k: number
  mode: HarnessMode
  seed: number | null
  tag: string
  sourceDir?: string
  /** Adopt the winning harness as the active one when the run earns a lesson. */
  adopt: boolean
}

/** One recursion run: the body of both `/harness run` and the autonomous child. */
async function executeHarnessRun(input: HarnessRunInput): Promise<string> {
  const paths = harnessPaths(input.domain)

  const baseTree = loadActiveHarness()
  try {
    validate(NEMO_SURFACE, baseTree, { profile: CODING_AGENT_PROFILE })
  } catch (error) {
    return (
      "The active harness does not validate, so there is no base to improve from.\n" +
      `${describe(error)}\n\nRun /harness show to inspect it.`
    )
  }
  const baseHarnessDir = saveActiveHarness(baseTree)

  const ports = createNemoHarnessPorts({ config: loadConfig(), baseHarnessDir })
  const proposer = new Proposer({ session: ports.session, auditDir: paths.auditDir })
  const task: HarnessTask = {
    id: `harness/${input.domain}/${Date.now().toString(36)}`,
    domain: input.domain,
    request: input.request,
    ...(input.sourceDir ? { sourceDir: input.sourceDir } : {}),
  }
  try {
    const result = await runTask(task, input.k, {
      task,
      surface: NEMO_SURFACE,
      profile: CODING_AGENT_PROFILE,
      baseHarnessDir,
      proposer,
      selector: proposer,
      rollout: ports.rollout,
      runsRoot: paths.runsRoot,
      modes: [input.mode],
      seed: input.seed,
      tag: input.tag,
      libraries: {
        [input.mode]: new HarnessLibrary({
          root: join(paths.libraryRoot, input.mode),
          domain: input.domain,
          surface: NEMO_SURFACE,
        }),
      },
      leakGlobs: [],
    })
    const modeResult = result.modes[input.mode] ?? null
    const selection = result.selections[input.mode] ?? null
    const text = describeRun({
      mode: input.mode,
      k: input.k,
      domain: input.domain,
      taskId: task.id,
      ledger: modeResult?.ledger ?? null,
      selection,
      fellBack: modeResult?.fellBack ?? [],
      keptBase: modeResult?.keptBase ?? [],
      stages: modeResult?.stages.length ?? 0,
      errors: [
        ...result.errors,
        ...(modeResult?.errors ?? []),
        ...(result.status === "base-failed" ? ["no base rollout produced anything"] : []),
      ],
      summaryPath: summaryPathFor({
        runsRoot: paths.runsRoot,
        surfaceName: NEMO_SURFACE.name,
        taskId: task.id,
        k: input.k,
        seed: input.seed,
        tag: input.tag,
      }),
    })
    return input.adopt ? text + adoptWinningHarness(task.id, selection) : text
  } catch (error) {
    return `The harness run failed before a summary was written:\n${describe(error)}`
  }
}

/**
 * Adopt the run's winner as the active harness.
 *
 * Only a run that filed a durable lesson may change what the next session
 * starts from — the same gate the library already uses. A fallback pick or
 * a lesson-less adoption is reported, not applied.
 */
function adoptWinningHarness(taskId: string, selection: HarnessSelection | null): string {
  if (!selection || !selection.ok || selection.fallback || !hasExperience(selection.experience)) {
    return "\n\nNo harness adopted: the run produced no durable lesson."
  }
  const pick = storedHarnesses(taskId, homedir())[0]
  if (!pick) return "\n\nNo harness adopted: nothing was stored for this task."
  try {
    const tree = readTree(NEMO_SURFACE, pick.dir)
    if (Object.keys(tree).length === 0) return "\n\nNo harness adopted: the stored tree is empty."
    const dir = saveActiveHarness(tree)
    return `\n\nAdopted automatically — the next session starts from it.\nSaved to ${dir}`
  } catch (error) {
    return `\n\nAdoption skipped: ${describe(error)}`
  }
}

/**
 * The autonomous child: run the task file the session-end trigger wrote.
 *
 * Minimal budget on purpose (k=1, parallel): this runs unattended on every
 * substantial session, so it buys one comparison, not a sweep.
 */
async function runAutoTask(file: string | undefined): Promise<string> {
  if (!file) return "Usage: nemo harness auto <task-file>"
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch (error) {
    return `Cannot read the harness task file: ${describe(error)}`
  }
  try {
    const request = typeof payload.request === "string" ? payload.request.trim() : ""
    if (!request) return "The harness task file has no request."
    const sourceDir =
      typeof payload.sourceDir === "string" && isDirectory(payload.sourceDir) ? payload.sourceDir : undefined
    if (!sourceDir) {
      return `The harness task source directory is missing: ${String(payload.sourceDir ?? "(none)")}`
    }
    const domain =
      typeof payload.domain === "string" && payload.domain.trim().length > 0
        ? payload.domain.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40)
        : "default"

    let text: string
    try {
      text = await executeHarnessRun({
        request,
        domain,
        k: 1,
        mode: modeToken("parallel"),
        seed: null,
        tag: "",
        sourceDir,
        adopt: true,
      })
    } catch (error) {
      // A failed improvement must never stop the update half of the run.
      text = `The improvement run failed: ${describe(error)}`
    }
    appendAutoLog(text)
    // Keep the CLI itself current too: same child, same window (the TUI is
    // already gone), so a git checkout can finally be updated for real.
    const update = await autoUpdateSelf({ config: { autoupdate: readAutoupdatePolicy() } })
    appendAutoLog(update)
    return `${text}\n${update}`
  } finally {
    try {
      rmSync(file, { force: true })
    } catch {
      /* a stuck task file is not worth failing the run for */
    }
  }
}

/** The user's update policy, or undefined (defaults) when config is unreadable. */
function readAutoupdatePolicy(): boolean | "notify" | undefined {
  try {
    return loadConfig().autoupdate
  } catch {
    return undefined
  }
}

/** `<root>/auto.log`: what the unattended runs decided, after the TUI is gone. */
function appendAutoLog(text: string): void {
  try {
    const file = join(harnessPaths("default").root, "auto.log")
    const line = `[${new Date().toISOString()}] ${text.replace(/\n+/g, " | ").slice(0, 2_000)}\n`
    appendFileSync(file, line, "utf8")
  } catch {
    /* logging must never fail an improvement run */
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function modifiedAt(dir: string): number {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
