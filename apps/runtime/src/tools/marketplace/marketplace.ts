/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"
import { loadSkillsFromDir } from "../skills/skills.js"

/**
 * Marketplace (legacy marketplace parity, offline edition): discover, search,
 * install, and remove shareable agent assets — skills (`SKILL.md` bundles)
 * and specialist profiles (markdown) — from a plain directory shelf.
 *
 * Layout of a marketplace source dir:
 *   <source>/skills/<name>/SKILL.md
 *   <source>/agents/<name>.md
 * Install targets are the project's `.nemo/skills/` + `.nemo/agents/`,
 * so installed assets load through the normal skills/agents pipeline with no
 * special casing. Names are charset-gated (`[A-Za-z0-9_-]`), which makes path
 * traversal unrepresentable.
 */

export type MarketplaceKind = "skill" | "agent"

export interface MarketplaceEntry {
  kind: MarketplaceKind
  name: string
  description: string
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function defaultMarketplaceSource(): string {
  return path.join(os.homedir(), ".nemo", "marketplace")
}

function readAgentCard(file: string, fallback: string): { name: string; description: string } | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---/)
  const fields: Record<string, string> = {}
  if (frontmatter) {
    for (const line of frontmatter[1]!.split("\n")) {
      const kv = line.match(/^\s*([^:]+):\s*(.*?)\s*$/)
      if (kv) fields[kv[1]!.trim().toLowerCase()] = kv[2]!.trim()
    }
  }
  return { name: fields.name ?? fallback, description: fields.description ?? "" }
}

/**
 * Resolve an advertised agent NAME to its source file. Discovery uses the
 * frontmatter name; the file itself may be named anything (e.g. agents with
 * descriptive filenames). Returns null when no shelf file advertises `name`.
 */
function findAgentFile(source: string, name: string): string | null {
  const agentsDir = path.join(source, "agents")
  let files: string[] = []
  try {
    files = fs.readdirSync(agentsDir)
  } catch {
    return null
  }
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    const card = readAgentCard(path.join(agentsDir, file), path.basename(file, ".md"))
    if (card && card.name === name) return path.join(agentsDir, file)
  }
  return null
}

/** List every installable entry on the shelf. Pure apart from fs. */
export function scanMarketplace(source: string): MarketplaceEntry[] {
  const out: MarketplaceEntry[] = []
  const skillsDir = path.join(source, "skills")
  if (fs.existsSync(skillsDir)) {
    for (const skill of loadSkillsFromDir(skillsDir)) {
      out.push({ kind: "skill", name: skill.name, description: skill.description })
    }
  }
  const agentsDir = path.join(source, "agents")
  let files: string[] = []
  try {
    files = fs.readdirSync(agentsDir)
  } catch {
    files = []
  }
  for (const file of files) {
    if (!file.endsWith(".md")) continue
    const card = readAgentCard(path.join(agentsDir, file), path.basename(file, ".md"))
    if (card && NAME_RE.test(card.name)) out.push({ kind: "agent", name: card.name, description: card.description })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Case-insensitive name/description search. Pure apart from fs. */
export function searchMarketplace(source: string, query: string): MarketplaceEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return scanMarketplace(source).filter(
    (entry) => entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle),
  )
}

function copyDirFiltered(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue // no symlink escapes
    const from = path.join(src, item.name)
    const to = path.join(dest, item.name)
    if (item.isDirectory()) copyDirFiltered(from, to)
    else fs.copyFileSync(from, to)
  }
}

/** Install one shelf entry into the project. Refuses to overwrite. */
export function installMarketplaceEntry(
  source: string,
  kind: MarketplaceKind,
  name: string,
  destRoot: string,
): { ok: true; message: string } | { ok: false; error: string } {
  if (!NAME_RE.test(name)) return { ok: false, error: `Invalid name '${name}' (use letters, digits, -, _).` }
  const nemoDir = path.join(destRoot, ".nemo")
  if (kind === "skill") {
    const from = path.join(source, "skills", name)
    if (!fs.existsSync(path.join(from, "SKILL.md"))) return { ok: false, error: `Skill '${name}' is not on the shelf.` }
    const to = path.join(nemoDir, "skills", name)
    if (fs.existsSync(to)) return { ok: false, error: `Skill '${name}' is already installed (remove it first).` }
    copyDirFiltered(from, to)
    return { ok: true, message: `Installed skill '${name}' → ${to}` }
  }
  // scanMarketplace advertises the FRONTMATTER name (readAgentCard), which may
  // differ from the file's base name — resolve the advertised name to its
  // actual file instead of assuming `<name>.md` exists on the shelf.
  const from = findAgentFile(source, name)
  if (!from) return { ok: false, error: `Agent '${name}' is not on the shelf.` }
  const to = path.join(nemoDir, "agents", `${name}.md`)
  if (fs.existsSync(to)) return { ok: false, error: `Agent '${name}' is already installed (remove it first).` }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  return { ok: true, message: `Installed agent '${name}' → ${to}` }
}

/** Remove an installed shelf entry from the project. */
export function removeMarketplaceEntry(
  kind: MarketplaceKind,
  name: string,
  destRoot: string,
): { ok: true; message: string } | { ok: false; error: string } {
  if (!NAME_RE.test(name)) return { ok: false, error: `Invalid name '${name}' (use letters, digits, -, _).` }
  const target =
    kind === "skill"
      ? path.join(destRoot, ".nemo", "skills", name)
      : path.join(destRoot, ".nemo", "agents", `${name}.md`)
  if (!fs.existsSync(target)) return { ok: false, error: `'${name}' is not installed.` }
  fs.rmSync(target, { recursive: true, force: true })
  return { ok: true, message: `Removed ${kind} '${name}'` }
}

function formatEntries(entries: MarketplaceEntry[]): string {
  if (entries.length === 0) return "Marketplace shelf is empty."
  return entries.map((e) => `- [${e.kind}] ${e.name}${e.description ? `: ${e.description}` : ""}`).join("\n")
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "marketplace",
  description:
    "Browse and install shareable agent assets (skills, specialist profiles) from a marketplace shelf directory into this project. Actions: list, search, install, remove. Installed assets load through the normal skills/agents pipeline.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", description: "One of: list, search, install, remove." },
      query: { type: "string", description: "Search text for the search action." },
      kind: { type: "string", description: "Asset kind for install/remove: skill or agent." },
      name: { type: "string", description: "Asset name for install/remove." },
      source: { type: "string", description: "Marketplace shelf directory. Defaults to ~/.nemo/marketplace." },
    },
  },
}

/** `marketplace` tool: shelf discovery + project installs. */
export function createMarketplaceTool(defaultSource?: string): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const action = String(args.action ?? "")
        .trim()
        .toLowerCase()
      const source =
        typeof args.source === "string" && args.source ? args.source : (defaultSource ?? defaultMarketplaceSource())
      const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd()
      switch (action) {
        case "list":
          return textResult(formatEntries(scanMarketplace(source)))
        case "search": {
          const query = String(args.query ?? "")
          if (!query.trim()) return textResult("Missing 'query' for search.", /*isError*/ true)
          const hits = searchMarketplace(source, query)
          return textResult(hits.length > 0 ? formatEntries(hits) : `No marketplace entries match '${query}'.`)
        }
        case "install": {
          const kind = String(args.kind ?? "")
            .trim()
            .toLowerCase()
          if (kind !== "skill" && kind !== "agent")
            return textResult("Missing 'kind' for install: skill or agent.", /*isError*/ true)
          const name = String(args.name ?? "")
          if (!name) return textResult("Missing 'name' for install.", /*isError*/ true)
          const result = installMarketplaceEntry(source, kind, name, cwd)
          return result.ok ? textResult(result.message) : textResult(result.error, /*isError*/ true)
        }
        case "remove": {
          const kind = String(args.kind ?? "")
            .trim()
            .toLowerCase()
          if (kind !== "skill" && kind !== "agent")
            return textResult("Missing 'kind' for remove: skill or agent.", /*isError*/ true)
          const name = String(args.name ?? "")
          if (!name) return textResult("Missing 'name' for remove.", /*isError*/ true)
          const result = removeMarketplaceEntry(kind, name, cwd)
          return result.ok ? textResult(result.message) : textResult(result.error, /*isError*/ true)
        }
        default:
          return textResult("Unknown action: use list, search, install, or remove.", /*isError*/ true)
      }
    },
  }
}
