/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The editable surface: paths, caps, per-surface rules — and the shared
 * logic that reads, validates, diffs and materialises it.
 *
 * Adapted from Harness² (Copyright 2026 Google LLC, Apache-2.0) — see
 * NOTICE.md in this directory.
 *
 * Everything that differs between agent frameworks is DATA on
 * {@link SurfaceSpec}: paths, caps, frontmatter rules, stubs. The logic
 * exists once, so a second surface is a value rather than a fork.
 */

import * as fs from "fs"
import * as path from "path"
import type {
  HarnessDiversity,
  HarnessProfile,
  HarnessTree,
} from "./types.js"

/** A harness surface: what a coding agent lets the harness edit. */
export interface SurfaceSpec {
  name: string
  /** Always-on files, in injection order. */
  alwaysOn: readonly string[]
  alwaysOnMax: number
  alwaysOnCapReason: string
  skillDir: string
  /** `must_match` requires `name:` to equal the directory. */
  skillNameRule: "must_match" | "may_override"
  /** The file an auto-added trigger line lands in. */
  autotriggerFile: string
  /** The trigger line template; `{name}` and `{desc}` are interpolated. */
  triggerLine: string
  subagentDir: string
  subagentRequiresMode: boolean
  scriptDir: string
  pluginDir: string | null
  /** README-style files the runtime ships and a harness may overwrite. */
  stubs: ReadonlyArray<readonly [string, string]>
  /** Refuse a harness whose always-on body is empty. */
  rejectEmptyAlwaysOn: boolean
}

/**
 * Nemo's coding-agent surface.
 *
 * c1 system prompt · c2 guardrails · c3 tool guidance · c4 memory ·
 * c5 skills · c6 subagents · c7 helper scripts · c8 plugins.
 */
export const NEMO_SURFACE: SurfaceSpec = {
  name: "nemo",
  alwaysOn: [
    "systemprompt.md",
    "guardrails.md",
    "tool_descriptions/tool_guidance.md",
    "memory.md",
  ],
  alwaysOnMax: 24_000,
  alwaysOnCapReason:
    "every token in the always-on body competes with the agent's own output budget",
  skillDir: "skills",
  skillNameRule: "must_match",
  autotriggerFile: "guardrails.md",
  triggerLine: "- When {desc}, load the `{name}` skill.",
  subagentDir: "sub_agents",
  subagentRequiresMode: true,
  scriptDir: "scripts",
  pluginDir: "plugins",
  stubs: [
    ["skills/README.md", "# Skills\n\nOne directory per skill: `<name>/SKILL.md`.\n"],
    [
      "sub_agents/README.md",
      "# Subagents\n\nOne directory per subagent: `<name>/AGENT.md`.\n",
    ],
    ["scripts/README.md", "# Helper scripts\n\nDeterministic `.mjs` helpers the agent may call.\n"],
    ["plugins/README.md", "# Plugins\n\n`.mjs` middleware that wraps the tool loop.\n"],
  ],
  rejectEmptyAlwaysOn: true,
}

/** Scripts the runtime ships; a harness may reference them without shipping them. */
export const RESERVED_SCRIPTS: ReadonlySet<string> = new Set([
  "read_doc.mjs",
  "pack.mjs",
  "unpack.mjs",
])

/** Name rule shared by every component: lowercase, digits, `_` or `-`. */
const NAME = "[a-z0-9][a-z0-9_-]*"

/** The compiled patterns for one surface. */
function patterns(surface: SurfaceSpec): {
  skill: RegExp
  skillScript: RegExp
  subagent: RegExp
  script: RegExp
  scriptRef: RegExp
  plugin: RegExp | null
} {
  const skillDir = escapeRegExp(surface.skillDir)
  const subagentDir = escapeRegExp(surface.subagentDir)
  const scriptDir = escapeRegExp(surface.scriptDir)
  return {
    skill: new RegExp(`^${skillDir}/(${NAME})/SKILL\\.md$`),
    skillScript: new RegExp(`^${skillDir}/${NAME}/scripts/[A-Za-z0-9_.-]+$`),
    subagent: new RegExp(`^${subagentDir}/(${NAME})/AGENT\\.md$`),
    script: new RegExp(`^${scriptDir}/[a-z0-9_][a-z0-9_]*\\.mjs$`),
    scriptRef: new RegExp(
      `(?:(?:node|bun)\\s+)((?:${skillDir}/[\\w-]+/)?${scriptDir}/[\\w.-]+\\.mjs)`,
      "g",
    ),
    plugin:
      surface.pluginDir === null
        ? null
        : new RegExp(`^${escapeRegExp(surface.pluginDir)}/(${NAME})\\.mjs$`),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Normalise a relative path, rejecting escapes before it is joined.
 *
 * A proposal may only edit files inside the harness: `..` segments and
 * absolute paths are refused before anything is written.
 */
export function normalizeRel(rel: string): string {
  let cleaned = String(rel).trim().replace(/\\/g, "/")
  if (cleaned.startsWith("/") || cleaned.split("/").some((part) => part === "..")) {
    throw new Error(`path escapes the harness: ${rel}`)
  }
  while (cleaned.startsWith("./")) cleaned = cleaned.slice(2)
  cleaned = cleaned.replace(/^\/+|\/+$/g, "")
  if (cleaned.length === 0) throw new Error("harness path is empty")
  return cleaned
}

/** Whether this path is on the editable surface. A predicate: it never raises. */
export function isAllowed(surface: SurfaceSpec, rel: string): boolean {
  let cleaned: string
  try {
    cleaned = normalizeRel(rel)
  } catch {
    return false
  }
  if (surface.alwaysOn.includes(cleaned)) return true
  const p = patterns(surface)
  if (
    p.skill.test(cleaned) ||
    p.skillScript.test(cleaned) ||
    p.subagent.test(cleaned) ||
    p.script.test(cleaned)
  ) {
    return true
  }
  return p.plugin !== null && p.plugin.test(cleaned)
}

/** The skill names present in a tree, sorted. */
export function skillNames(surface: SurfaceSpec, tree: HarnessTree): string[] {
  const rx = patterns(surface).skill
  const out = new Set<string>()
  for (const rel of Object.keys(tree)) {
    const match = rx.exec(rel)
    if (match) out.add(match[1]!)
  }
  return [...out].sort()
}

/** The subagent names present in a tree, sorted. */
export function subagentNames(surface: SurfaceSpec, tree: HarnessTree): string[] {
  const rx = patterns(surface).subagent
  const out = new Set<string>()
  for (const rel of Object.keys(tree)) {
    const match = rx.exec(rel)
    if (match) out.add(match[1]!)
  }
  return [...out].sort()
}

/** The stub paths, which are not part of the tree. */
function stubPaths(surface: SurfaceSpec): Set<string> {
  return new Set(surface.stubs.map(([rel]) => rel))
}

/**
 * Read the tree off disk, skipping README stubs.
 *
 * Pass `rejected` to collect paths that exist on disk but are off the
 * surface: those are edits the runtime refuses to apply, and the proposer
 * is told about them verbatim.
 */
export function readTree(surface: SurfaceSpec, dir: string, rejected?: string[]): HarnessTree {
  const out: HarnessTree = {}
  if (!isDirectory(dir)) return out
  const stubs = stubPaths(surface)
  walk(dir)
    .map((file) => path.relative(dir, file).replace(/\\/g, "/"))
    .sort()
    .forEach((rel) => {
      if (stubs.has(rel)) return
      if (!isAllowed(surface, rel)) {
        rejected?.push(rel)
        return
      }
      try {
        out[rel] = fs.readFileSync(path.join(dir, rel), "utf8")
      } catch {
        /* unreadable: leave it out, the stage will notice an empty tree */
      }
    })
  return out
}

/** Whether a directory looks like a harness for this surface. */
export function isTree(surface: SurfaceSpec, dir: string): boolean {
  if (!isDirectory(dir)) return false
  return surface.alwaysOn.some((rel) => isFile(path.join(dir, rel)))
}

/**
 * Materialise an exact tree.
 *
 * Files outside the surface are preserved; editable files already there
 * are not. The always-on files are always present, so an editor sees the
 * full shape even when a component is empty.
 */
export function writeTree(
  surface: SurfaceSpec,
  tree: HarnessTree,
  dest: string,
  options: { stubs?: boolean } = {},
): string {
  fs.mkdirSync(dest, { recursive: true })
  const stubs = stubPaths(surface)
  for (const file of walk(dest).reverse()) {
    const rel = path.relative(dest, file).replace(/\\/g, "/")
    if (isAllowed(surface, rel) || stubs.has(rel)) fs.rmSync(file, { force: true })
  }
  for (const rel of surface.alwaysOn) {
    const target = path.join(dest, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (!(rel in tree) && !fs.existsSync(target)) fs.writeFileSync(target, "", "utf8")
  }
  for (const [rel, body] of Object.entries(tree)) {
    const target = path.join(dest, normalizeRel(rel))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body, "utf8")
  }
  if (options.stubs !== false) {
    for (const [rel, body] of surface.stubs) {
      const target = path.join(dest, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (!fs.existsSync(target)) fs.writeFileSync(target, body, "utf8")
    }
  }
  return dest
}

/** The concatenated always-on body, in injection order. */
export function alwaysOnText(surface: SurfaceSpec, tree: HarnessTree): string {
  return surface.alwaysOn.map((rel) => tree[rel] ?? "").join("\n\n")
}

/**
 * Repair a tree by adding a trigger line for every skill that is not named
 * in the always-on body.
 *
 * An untriggered skill is dead weight: it is never loaded, so it costs
 * budget and buys nothing. The repair runs BEFORE validation, and the
 * added lines count as part of the proposal. A line that would push the
 * body over the cap is skipped instead of silently overflowing.
 */
export function autotrigger(
  surface: SurfaceSpec,
  tree: HarnessTree,
  options: { alwaysOnMax?: number } = {},
): string[] {
  const cap = options.alwaysOnMax ?? surface.alwaysOnMax
  const fixed: string[] = []
  for (const name of skillNames(surface, tree)) {
    if (alwaysOnText(surface, tree).includes(name)) continue
    const body = tree[`${surface.skillDir}/${name}/SKILL.md`] ?? ""
    const description = (frontmatterValue(body, "description") ?? `the ${name} workflow applies`)
      .replace(/\.$/, "")
      .trim()
    const line = surface.triggerLine.replace("{name}", name).replace("{desc}", description)
    if (alwaysOnText(surface, tree).length + line.length + 2 > cap) continue
    const current = tree[surface.autotriggerFile] ?? ""
    tree[surface.autotriggerFile] =
      current.trim().length > 0 ? `${current.trimEnd()}\n${line}` : line
    fixed.push(name)
  }
  return fixed
}

/** Read a `key: value` out of a SKILL.md / AGENT.md frontmatter block. */
export function frontmatterValue(body: string, key: string): string | undefined {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return undefined
  for (const row of match[1]!.split(/\r?\n/)) {
    const line = row.trim()
    if (!line.toLowerCase().startsWith(`${key.toLowerCase()}:`)) continue
    return line.slice(line.indexOf(":") + 1).trim()
  }
  return undefined
}

/** The validation census returned alongside a clean validation. */
export interface HarnessCensus {
  alwaysOnChars: number
  nFiles: number
  skills: number
  subagents: number
  scripts: number
  plugins: number
}

/**
 * Validate a tree.
 *
 * Every problem is collected and raised at once, so a proposer gets the
 * whole list in one retry instead of discovering the rules one at a time.
 * Validation is the gate, not the model: a tree that fails here is never
 * rolled out.
 */
export function validate(
  surface: SurfaceSpec,
  tree: HarnessTree,
  options: {
    allowSubagents?: boolean
    alwaysOnMax?: number
    reservedScripts?: ReadonlySet<string>
    profile?: HarnessProfile
  } = {},
): HarnessCensus {
  const allowSubagents = options.allowSubagents ?? true
  const cap = options.alwaysOnMax ?? surface.alwaysOnMax
  const reserved = options.reservedScripts ?? RESERVED_SCRIPTS
  const errors: string[] = []
  const body = alwaysOnText(surface, tree)
  const p = patterns(surface)

  if (body.length > cap) {
    errors.push(
      `always-on content is ${body.length} chars, over the ${cap} cap; ${surface.alwaysOnCapReason}`,
    )
  }
  if (surface.rejectEmptyAlwaysOn && body.trim().length === 0) {
    errors.push(
      `${surface.alwaysOn[0]} is empty — an empty always-on body is a harness that does not exist`,
    )
  }
  if (Object.keys(tree).length === 0) {
    errors.push("the harness tree is empty — there is nothing for the agent to work from")
  }

  // The harness body is literal text, never a template.
  for (const [rel, fileBody] of Object.entries(tree)) {
    if (/\{\{|\{%|\{#/.test(fileBody)) {
      errors.push(`${rel} contains template braces; the harness body is literal text`)
    }
  }

  // Skills: a name that does not match, or no description, is dropped at load.
  for (const name of skillNames(surface, tree)) {
    const rel = `${surface.skillDir}/${name}/SKILL.md`
    const fileBody = tree[rel] ?? ""
    if (!frontmatterValue(fileBody, "description")) {
      errors.push(`${rel} needs a \`description:\` in its frontmatter, or the skill is dropped SILENTLY at load`)
    }
    const declared = frontmatterValue(fileBody, "name")
    if (surface.skillNameRule === "must_match" && declared !== name) {
      errors.push(
        `${rel} needs frontmatter \`name: ${name}\` matching its directory (a mismatch is dropped SILENTLY at load)`,
      )
    } else if (surface.skillNameRule === "may_override" && declared && declared !== name) {
      errors.push(
        `${rel} frontmatter \`name: ${declared}\` OVERRIDES the directory name, so every trigger naming \`${name}\` stops matching`,
      )
    }
    if (!body.includes(name)) {
      errors.push(
        `skill '${name}' is never named in the always-on text, so the agent will not know to invoke it — an untriggered skill is dead weight`,
      )
    }
  }

  // Subagents: mode frontmatter, description, and the deployment switch.
  const subs = subagentNames(surface, tree)
  if (subs.length > 0 && !allowSubagents) {
    errors.push(`sub_agents are not available on this deployment: ${subs.join(", ")}`)
  }
  for (const name of subs) {
    const rel = `${surface.subagentDir}/${name}/AGENT.md`
    const fileBody = tree[rel] ?? ""
    if (surface.subagentRequiresMode && frontmatterValue(fileBody, "mode") !== "subagent") {
      errors.push(`${rel} needs frontmatter \`mode: subagent\``)
    }
    if (!frontmatterValue(fileBody, "description")) {
      errors.push(`${rel} needs a \`description:\``)
    }
  }

  // Plugin and script files must look like modules, not prose.
  for (const rel of Object.keys(tree)) {
    if (p.script.test(rel) && !(tree[rel] ?? "").trim()) {
      errors.push(`${rel} is empty; a helper script that does nothing is worse than none`)
    }
    if (p.plugin?.test(rel) && !(tree[rel] ?? "").trim()) {
      errors.push(`${rel} is empty; a plugin that does nothing is worse than none`)
    }
  }

  // Every script a skill or always-on file invokes must ship.
  const shipped = new Set(
    Object.keys(tree).filter((rel) => p.script.test(rel) || p.skillScript.test(rel)),
  )
  for (const [rel, src] of Object.entries(tree)) {
    if (!(p.skill.test(rel) || surface.alwaysOn.includes(rel))) continue
    for (const match of src.matchAll(p.scriptRef)) {
      const ref = match[1]!
      const base = ref.slice(ref.lastIndexOf("/") + 1)
      if (reserved.has(base)) continue
      if (!shipped.has(ref) && !shipped.has(base)) {
        errors.push(`${rel} invokes \`${ref}\` but that file is not in the harness`)
      }
    }
  }

  if (errors.length > 0) throw new Error(errors.join(" | "))

  const count = (rx: RegExp): number => Object.keys(tree).filter((rel) => rx.test(rel)).length
  return {
    alwaysOnChars: body.length,
    nFiles: Object.keys(tree).length,
    skills: skillNames(surface, tree).length,
    subagents: subs.length,
    scripts: count(p.script),
    plugins: p.plugin === null ? 0 : count(p.plugin),
  }
}

/** Structural diff between two trees. */
export function diffSummary(
  surface: SurfaceSpec,
  before: HarnessTree,
  after: HarnessTree,
): {
  added: string[]
  removed: string[]
  modified: string[]
  alwaysOnCharDelta: number
} {
  const beforeKeys = Object.keys(before)
  const afterKeys = Object.keys(after)
  return {
    added: afterKeys.filter((rel) => !(rel in before)).sort(),
    removed: beforeKeys.filter((rel) => !(rel in after)).sort(),
    modified: beforeKeys.filter((rel) => rel in after && before[rel] !== after[rel]).sort(),
    alwaysOnCharDelta:
      alwaysOnText(surface, after).length - alwaysOnText(surface, before).length,
  }
}

/**
 * Pairwise line-Jaccard across candidate trees.
 *
 * A collapse to one body shows up as a mean similarity near 1, which is how
 * "the k candidates were not independent" becomes visible.
 */
export function diversity(trees: Record<string, HarnessTree>): HarnessDiversity {
  const names = Object.keys(trees).sort()
  const lines = (tree: HarnessTree): Set<string> => {
    const out = new Set<string>()
    for (const [rel, body] of Object.entries(tree)) {
      for (const line of body.split(/\r?\n/)) {
        if (line.trim().length > 0) out.add(`${rel}:${line}`)
      }
    }
    return out
  }
  if (names.length < 2) {
    return { n: names.length, nDistinct: names.length, meanLineJaccard: 1 }
  }
  const sets = names.map((name) => lines(trees[name] ?? {}))
  const sims: number[] = []
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      let intersection = 0
      for (const value of sets[i]!) if (sets[j]!.has(value)) intersection++
      const union = sets[i]!.size + sets[j]!.size - intersection
      sims.push(union === 0 ? 1 : intersection / union)
    }
  }
  const distinct = new Set(names.map((name) => JSON.stringify(trees[name] ?? {}))).size
  return {
    n: names.length,
    nDistinct: distinct,
    meanLineJaccard: Number((sims.reduce((acc, value) => acc + value, 0) / sims.length).toFixed(4)),
  }
}

/** A one-line census of the components actually in a harness. */
export function inventory(surface: SurfaceSpec, tree: HarnessTree): string {
  const p = patterns(surface)
  const count = (predicate: (rel: string) => boolean): number =>
    Object.keys(tree).filter(predicate).length
  const bits: string[] = []
  const skills = count((rel) => p.skill.test(rel))
  const subs = count((rel) => p.subagent.test(rel))
  const scripts = count((rel) => p.script.test(rel))
  const plugins = p.plugin === null ? 0 : count((rel) => p.plugin!.test(rel))
  if (skills > 0) bits.push(`${skills} skills`)
  if (subs > 0) bits.push(`${subs} subagents`)
  if (scripts > 0) bits.push(`${scripts} scripts`)
  if (plugins > 0) bits.push(`${plugins} plugins`)
  if (bits.length === 0) bits.push("always-on edits only")
  return `${bits.join(", ")}; ${alwaysOnText(surface, tree).length.toLocaleString("en-US")} always-on chars`
}

/** The harness a coding agent starts from: always-on files only. */
export function baseHarness(profile?: Partial<HarnessProfile>): HarnessTree {
  const work = profile?.work ?? "the task"
  return {
    "systemprompt.md": [
      "You are Nemo, a terminal coding agent.",
      "",
      `Work ${work} in small, verifiable steps. Read before you write.`,
      "Prefer the smallest change that makes the task true, and say what you",
      "changed and what you verified.",
    ].join("\n"),
    "guardrails.md": [
      "- Never run a destructive command without an explicit yes.",
      "- Never print a secret; redact values you did not need.",
      "- Stop and report when the task needs a decision only the user can make.",
    ].join("\n"),
    "tool_descriptions/tool_guidance.md": [
      "# Tool guidance",
      "",
      "- Read a file before editing it; an edit against an imagined file is a guess.",
      "- After a change, run the narrowest check that could falsify it.",
      "- When a command fails, read the error before retrying; never repeat it blind.",
    ].join("\n"),
    "memory.md": "",
  }
}

/** Whether a path is a directory. */
export function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Every file under `dir`, recursively, deterministic order. */
export function walk(dir: string): string[] {
  const out: string[] = []
  const visit = (current: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue
        visit(full)
        continue
      }
      if (entry.isFile()) out.push(full)
    }
  }
  visit(dir)
  return out.sort()
}
