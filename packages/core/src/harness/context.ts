/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The evidence tree an improver reads. The only way evidence reaches a model.
 *
 *     context/task.md                  the task as the agent received it
 *     context/source/                  the material the work was done from
 *     context/rollouts/<label>.md      full trajectory -- no prompt-budget truncation
 *     context/deliverables/<label>.md  what the rollout produced
 *     context/harness/<rel>            the tree being edited
 *     context/library/INDEX.md         earlier tasks in this domain + their harnesses
 *     context/pool/<label>/            candidate harness + its rollout (compose only)
 *     context/decisions/<label>.md     the notes an earlier stage wrote
 *
 * Two guards run on every tree before it can reach a model: no answer-key
 * path may enter, and no grader verdict may enter. Both are tripwires on
 * the read boundary; when one fires, find the read path rather than
 * widening the marker list.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 */

import * as fs from "fs"
import * as path from "path"
import type { HarnessContextTree, HarnessRun, HarnessTree } from "./types.js"
import type { HarnessTask } from "./ports.js"
import { walk } from "./tree.js"

/** One pool candidate: its materialised harness and its own rollout. */
export interface ContextPoolEntry {
  label: string
  harnessDir: string | null
  run: HarnessRun | null
}

/** What to put in the evidence tree. */
export interface ContextBuildInput {
  /** The context root. The proposer copies this to `<workspace>/context`. */
  dest: string
  task: HarnessTask
  rollouts?: readonly HarnessRun[]
  harnessDir?: string | null
  libraryDir?: string | null
  pool?: readonly ContextPoolEntry[]
  decisions?: Record<string, string>
  /** Write deliverable bodies, or only their names. Default: contents. */
  deliverables?: "contents" | "names"
  /** Answer-key path globs the task declares. Empty for an open coding task. */
  leakGlobs?: readonly string[]
  /** Skip any source file larger than this. Default 4 MiB. */
  maxSourceBytes?: number
}

/** The grader's own output. Never serve it as evidence. */
export const GRADER_VERDICT_MARKERS: readonly string[] = [
  "deterministic_eval_summary",
  "deterministic_eval_result",
  "judge_scope_and_deterministic_status",
  "Judge findings on the rendered result",
  '"passed_count"',
  '"pass_rate"',
  '"test_pass_rate"',
]

const SCAN_SUFFIXES = new Set([
  "",
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".html",
  ".htm",
  ".log",
  ".py",
  ".js",
  ".mjs",
  ".ts",
  ".sh",
  ".xml",
  ".ini",
  ".toml",
  ".patch",
  ".diff",
])

/** Build the evidence tree; return what landed so the mission describes only that. */
export function buildContext(input: ContextBuildInput): HarnessContextTree {
  const dest = input.dest
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })

  const taskBody = [input.task.request.trim(), input.task.notes?.trim() ?? ""]
    .filter((part) => part.length > 0)
    .join("\n\n---\n\n")
  fs.writeFileSync(path.join(dest, "task.md"), `${taskBody}\n`, "utf8")

  const sourceFiles = copySource(
    input.task.sourceDir ?? null,
    dest,
    input.leakGlobs ?? [],
    input.maxSourceBytes ?? 4 * 1024 * 1024,
  )

  for (const [label, notes] of Object.entries(input.decisions ?? {})) {
    const target = path.join(dest, "decisions", `${safeName(label)}.md`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${(notes || "No decision notes returned.").trim()}\n`, "utf8")
  }

  const gotRollouts: string[] = []
  const gotDeliverables: string[] = []
  const failed: string[] = []
  const namesOnly = input.deliverables === "names"
  if ((input.rollouts?.length ?? 0) > 0) {
    fs.mkdirSync(path.join(dest, "rollouts"), { recursive: true })
    fs.mkdirSync(path.join(dest, "deliverables"), { recursive: true })
  }
  for (const run of input.rollouts ?? []) {
    const failure = writeRollout(dest, run, namesOnly)
    if (failure) failed.push(failure)
    else gotRollouts.push(run.label)
    gotDeliverables.push(run.label)
  }

  let harnessFiles = 0
  const harnessDir = input.harnessDir ?? null
  if (harnessDir !== null && isDirectory(harnessDir)) {
    assertNoLeakPaths(harnessDir, input.leakGlobs ?? [])
    harnessFiles = copyTree(harnessDir, path.join(dest, "harness"))
  }

  const pool: string[] = []
  for (const entry of input.pool ?? []) {
    const dir = path.join(dest, "pool", safeName(entry.label))
    fs.mkdirSync(dir, { recursive: true })
    if (entry.harnessDir !== null && isDirectory(entry.harnessDir)) {
      assertNoLeakPaths(entry.harnessDir, input.leakGlobs ?? [])
      copyTree(entry.harnessDir, path.join(dir, "harness"))
      if (harnessDir !== null && isDirectory(harnessDir)) {
        const reference = readTextTree(harnessDir)
        const candidate = readTextTree(entry.harnessDir)
        fs.writeFileSync(
          path.join(dir, "harness.diff"),
          treeDiff(reference, candidate, entry.label),
          "utf8",
        )
      }
    }
    if (entry.run !== null) {
      fs.writeFileSync(
        path.join(dir, "rollout.md"),
        `${entry.run.transcript || "(no trajectory recorded)"}\n`,
        "utf8",
      )
      fs.writeFileSync(
        path.join(dir, "produced.md"),
        `${renderDeliverable(entry.run) || "(nothing produced)"}\n`,
        "utf8",
      )
    }
    pool.push(entry.label)
  }

  let library = false
  const libraryDir = input.libraryDir ?? null
  if (libraryDir !== null && isDirectory(libraryDir) && anyEntry(libraryDir)) {
    assertNoLeakPaths(libraryDir, input.leakGlobs ?? [])
    copyTree(libraryDir, path.join(dest, "library"))
    library = true
  }

  assertNoLeakPaths(dest, input.leakGlobs ?? [])
  assertNoGraderVerdicts(dest)

  if ((input.rollouts?.length ?? 0) > 0 && gotRollouts.length === 0) {
    throw new Error(
      "no trajectory could be rendered for ANY rollout -- the improver would be adapting on " +
        `nothing: ${failed.slice(0, 4).join("; ")}`,
    )
  }

  const tree: HarnessContextTree = {
    root: dest,
    taskId: input.task.id,
    rollouts: gotRollouts,
    deliverables: gotDeliverables,
    harnessFiles,
    library,
    pool,
    failed,
    sourceFiles,
    decisions: Object.keys(input.decisions ?? {}).length,
    layout: "",
    deliverablesMode: namesOnly ? "names" : "contents",
  }
  tree.layout = layoutOf(tree)
  return tree
}

/** The short pointer to the evidence on disk: the job, where it is, and how to read it. */
export function mission(tree: HarnessContextTree, input: { job: string }): string {
  return [
    input.job.trim(),
    "",
    "# YOUR EVIDENCE",
    "",
    "It is on disk, in `context/`. Read it -- do not answer from this message alone.",
    "",
    tree.layout,
    "",
    "Every trajectory EVENT is present: the trajectory was not clipped to fit this mission. " +
      "An individual observation may contain an explicit renderer-truncation marker; that " +
      "marker is ours, not behaviour by the agent. Do not diagnose it as an agent failure.",
    "",
    "Read `task.md` and the current harness first. Inventory every available rollout or " +
      "candidate and inspect each at least once before deciding. For a candidate, compare " +
      "what changed from its editing baseline, what behaviour changed in its rollout, what " +
      "improved, and what regressed or remained unresolved. Then deep-read the evidence " +
      "relevant to any edit. Cite the specific trajectory moment behind every change; one " +
      "you cannot trace to a moment is speculation.",
  ].join("\n")
}

function layoutOf(tree: HarnessContextTree): string {
  const lines = ["```", "context/task.md                  the request, verbatim"]
  if (tree.sourceFiles > 0) {
    lines.push(`context/source/                  the material the work was done from (${tree.sourceFiles} file(s))`)
  }
  if (tree.rollouts.length > 0) {
    lines.push(
      "context/rollouts/<label>.md      FULL trajectories -- nothing clipped to fit a prompt",
    )
  }
  if (tree.deliverables.length > 0) {
    lines.push(
      tree.deliverablesMode === "names"
        ? "context/deliverables/            which files each rollout produced (contents withheld)"
        : "context/deliverables/            what each rollout actually PRODUCED",
    )
  }
  if (tree.harnessFiles > 0) {
    lines.push(`context/harness/<rel>            the tree you edit (${tree.harnessFiles} file(s))`)
  }
  if (tree.library) {
    lines.push("context/library/                 earlier tasks in this area -- browse INDEX.md first")
  }
  if (tree.pool.length > 0) {
    lines.push(
      "context/pool/<label>/            one candidate per directory: `harness/`, `harness.diff`,",
      "                                 `rollout.md`, `produced.md`",
    )
  }
  if (tree.decisions > 0) {
    lines.push("context/decisions/<label>.md     the notes earlier stages wrote for these edits")
  }
  lines.push("```")
  return lines.join("\n")
}

/** Copy a task's source material under `<dest>/source`, minus answer-key paths. */
export function copySource(
  sourceDir: string | null,
  dest: string,
  leakGlobs: readonly string[] = [],
  maxBytes = 4 * 1024 * 1024,
): number {
  if (sourceDir === null || !isDirectory(sourceDir)) return 0
  const target = path.join(dest, "source")
  let copied = 0
  for (const file of walk(sourceDir)) {
    const rel = path.relative(sourceDir, file).replace(/\\/g, "/")
    if (isLeak(rel, leakGlobs)) continue
    try {
      if (fs.statSync(file).size > maxBytes) continue
      const body = fs.readFileSync(file)
      const out = path.join(target, rel)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, body)
      copied++
    } catch {
      /* unreadable: skip it, the guard below still runs */
    }
  }
  if (copied > 0) assertNoLeakPaths(target, leakGlobs)
  return copied
}

/** Write one rollout's trajectory and deliverables; return "" or the failure detail. */
function writeRollout(dest: string, run: HarnessRun, namesOnly: boolean): string {
  let failure = ""
  try {
    fs.writeFileSync(
      path.join(dest, "rollouts", `${safeName(run.label)}.md`),
      `${run.transcript || "(no trajectory recorded)"}\n`,
      "utf8",
    )
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    fs.writeFileSync(
      path.join(dest, "rollouts", `${safeName(run.label)}.md`),
      `(trajectory unavailable: ${detail})\n`,
      "utf8",
    )
    failure = `${run.label}: ${detail}`
  }

  const perFile = run.deliverableFiles ?? {}
  if (namesOnly) {
    const dir = path.join(dest, "deliverables", safeName(run.label))
    fs.mkdirSync(dir, { recursive: true })
    const names =
      Object.keys(perFile).length > 0
        ? Object.keys(perFile)
        : run.deliverable.trim().length > 0
          ? ["deliverable.md"]
          : []
    fs.writeFileSync(
      path.join(dir, "INDEX.md"),
      [
        `# ${run.label} produced ${names.length} file(s)`,
        "",
        ...names.map((name) => `- \`${name}\``),
        "",
        "CONTENTS ARE WITHHELD ON THIS PATH, DELIBERATELY. You are shown WHICH files the " +
          "rollout produced and not what is inside them. Reason about the work from the " +
          "TRAJECTORY and from the file set itself: a missing or misnamed file is a finding.",
        "",
      ].join("\n"),
      "utf8",
    )
    return failure
  }

  if (Object.keys(perFile).length > 0) {
    const dir = path.join(dest, "deliverables", safeName(run.label))
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(perFile)) {
      const safe = safeName(name).replace(/^\.+/, "unnamed")
      fs.writeFileSync(path.join(dir, `${safe}.txt`), `${body}\n`, "utf8")
    }
    fs.writeFileSync(
      path.join(dir, "INDEX.md"),
      [
        `# ${run.label} produced ${Object.keys(perFile).length} file(s)`,
        "",
        ...Object.entries(perFile).map(
          ([name, body]) => `- \`${name}\`  (${body.length.toLocaleString("en-US")} chars)`,
        ),
        "",
        "Each `.txt` is the artifact rendered as text. Reason about correctness from these.",
        "",
      ].join("\n"),
      "utf8",
    )
    return failure
  }

  fs.writeFileSync(
    path.join(dest, "deliverables", `${safeName(run.label)}.md`),
    `${renderDeliverable(run) || "(no deliverable produced)"}\n`,
    "utf8",
  )
  return failure
}

/** The artifact a rollout produced, as text. */
export function renderDeliverable(run: HarnessRun): string {
  if (run.deliverable.trim().length > 0) return run.deliverable
  const files = Object.entries(run.deliverableFiles ?? {})
  if (files.length === 0) return ""
  return files
    .map(([name, body]) => `# ${name}\n\n${body}`.trim())
    .join("\n\n---\n\n")
}

/** Reject task-declared answer-key paths before a context reaches a model. */
export function assertNoLeakPaths(root: string, patterns: readonly string[]): void {
  if (patterns.length === 0 || !isDirectory(root)) return
  const hits: string[] = []
  for (const file of walk(root)) {
    const rel = path.relative(root, file).replace(/\\/g, "/")
    const pattern = patterns.find((candidate) => isLeak(rel, [candidate]))
    if (pattern) hits.push(rel)
  }
  if (hits.length > 0) {
    throw new Error(
      `answer-key path(s) would enter model context: ${hits.sort().slice(0, 8).join(", ")}`,
    )
  }
}

/** A glob match with `*`, `?` and `**`, matching at the root or one level down. */
function isLeak(rel: string, patterns: readonly string[]): boolean {
  const clean = rel.replace(/^\.?\//, "")
  return patterns.some((pattern) => {
    const glob = pattern.replace(/\\/g, "/").replace(/^\.?\//, "")
    return globMatch(clean, glob) || globMatch(clean, `*/${glob}`) || globMatch(clean, `**/${glob}`)
  })
}

function globMatch(value: string, glob: string): boolean {
  const source = glob
    .split("")
    .map((char) => {
      if (char === "*") return ".*"
      if (char === "?") return "."
      return char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    })
    .join("")
    .replace(/\.\.\*\//g, "(?:.*/)?")
  return new RegExp(`^${source}$`).test(value)
}

/** Refuse a context tree containing the grader's own output, by name and by content. */
export function assertNoGraderVerdicts(
  root: string,
  markers: readonly string[] = GRADER_VERDICT_MARKERS,
): void {
  if (markers.length === 0 || !isDirectory(root)) return
  for (const file of walk(root)) {
    const rel = path.relative(root, file).replace(/\\/g, "/")
    for (const marker of markers) {
      if (rel.includes(marker)) {
        throw new Error(
          `grader verdict would enter model context: ${JSON.stringify(rel)} matched marker ` +
            `${JSON.stringify(marker)} in its NAME. This is a leak, not a false positive to ` +
            "widen around. Find the read path that produced it.",
        )
      }
    }
    if (!SCAN_SUFFIXES.has(path.extname(file).toLowerCase())) continue
    let body: string
    try {
      body = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const marker of markers) {
      const at = body.indexOf(marker)
      if (at < 0) continue
      throw new Error(
        `grader verdict would enter model context: ${JSON.stringify(rel)} contains marker ` +
          `${JSON.stringify(marker)} at offset ${at} (${JSON.stringify(
            body.slice(Math.max(0, at - 60), at + 120),
          )}). This is a leak, not a false positive to widen around.`,
      )
    }
  }
}

/** The same tripwire on an agent-authored harness tree, before it can be rolled or stored. */
export function assertTreeHasNoGraderVerdicts(
  tree: HarnessTree,
  markers: readonly string[] = GRADER_VERDICT_MARKERS,
): void {
  for (const rel of Object.keys(tree).sort()) {
    for (const marker of markers) {
      if (rel.includes(marker)) {
        throw new Error(
          `harness file ${JSON.stringify(rel)} has grader-verdict marker ` +
            `${JSON.stringify(marker)} in its NAME; rename it -- files carrying these strings ` +
            "cannot be served as evidence to later tasks",
        )
      }
    }
    if (!SCAN_SUFFIXES.has(path.extname(rel).toLowerCase())) continue
    const body = tree[rel] ?? ""
    for (const marker of markers) {
      const at = body.indexOf(marker)
      if (at < 0) continue
      throw new Error(
        `harness file ${JSON.stringify(rel)} contains grader-verdict marker ` +
          `${JSON.stringify(marker)} at offset ${at} (${JSON.stringify(
            body.slice(Math.max(0, at - 60), at + 120),
          )}); remove or rename that string -- files carrying it cannot be served as evidence to ` +
          "later tasks",
      )
    }
  }
}

/**
 * Bounds for a copy.
 *
 * The defaults keep the old behaviour (copy everything `walk` finds). The
 * source tree of a task can be a whole repository, so a caller that copies
 * one at session end passes a skip set and caps: a rollout is evidence, not
 * a backup, and copying `node_modules` or `.nemo/checkpoints` would
 * stall the machine for minutes before the first model call.
 */
export interface CopyTreeOptions {
  /** Directory names skipped at any depth, in addition to node_modules/.git. */
  skipDirs?: ReadonlySet<string>
  /** Stop once this many files were copied. */
  maxFiles?: number
  /** Stop before the copied source bytes would exceed this. */
  maxBytes?: number
}

/** Copy a component tree; return the file count. */
export function copyTree(src: string, dst: string, options: CopyTreeOptions = {}): number {
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const skipDirs = options.skipDirs
  let count = 0
  let bytes = 0

  const visit = (current: string): void => {
    if (count >= maxFiles || bytes >= maxBytes) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= maxFiles || bytes >= maxBytes) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue
        if (skipDirs?.has(entry.name)) continue
        visit(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const size = fs.statSync(full).size
        if (bytes + size > maxBytes) continue
        const target = path.join(dst, path.relative(src, full))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(full, target)
        bytes += size
        count++
      } catch {
        /* unreadable source file: leave it out */
      }
    }
  }

  visit(src)
  return count
}

/** Read a flat text tree from disk. */
function readTextTree(dir: string): HarnessTree {
  const out: HarnessTree = {}
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file).replace(/\\/g, "/")
    try {
      out[rel] = fs.readFileSync(file, "utf8")
    } catch {
      /* unreadable: leave it out */
    }
  }
  return out
}

/** A compact line diff between two trees, for the compose evidence. */
function treeDiff(before: HarnessTree, after: HarnessTree, label: string): string {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const chunks: string[] = []
  for (const name of names) {
    const old = before[name]
    const next = after[name]
    if (old === next) continue
    chunks.push(`--- current/${name}`)
    chunks.push(`+++ ${label}/${name}`)
    if (old === undefined) {
      chunks.push(...(next ?? "").split(/\r?\n/).map((line) => `+${line}`))
      continue
    }
    if (next === undefined) {
      chunks.push(...old.split(/\r?\n/).map((line) => `-${line}`))
      continue
    }
    chunks.push(...lineDiff(old, next))
  }
  return chunks.length === 0 ? "(no structural change)\n" : `${chunks.join("\n")}\n`
}

/** Line diff with a bounded LCS; falls back to whole-file replacement past the cap. */
function lineDiff(before: string, after: string): string[] {
  const left = before.split(/\r?\n/)
  const right = after.split(/\r?\n/)
  if (left.length * right.length > 250_000) {
    return [...left.map((line) => `-${line}`), ...right.map((line) => `+${line}`)]
  }
  const rows = left.length
  const cols = right.length
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i]![j] =
        left[i] === right[j] ? (lcs[i + 1]![j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      out.push(` ${left[i]}`)
      i++
      j++
      continue
    }
    if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      out.push(`-${left[i]}`)
      i++
    } else {
      out.push(`+${right[j]}`)
      j++
    }
  }
  while (i < rows) out.push(`-${left[i++]}`)
  while (j < cols) out.push(`+${right[j++]}`)
  return out
}

/** A path-safe form of a label. */
export function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "_")
  return cleaned.length > 0 ? cleaned : "unnamed"
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function anyEntry(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}
