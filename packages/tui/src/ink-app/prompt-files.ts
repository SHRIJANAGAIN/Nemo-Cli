/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Project/user prompt files as custom slash commands — SKT AI LABS's
 * `{command,commands}` + `**\/*.md` glob port. Any `.md` file under
 *
 *   ./commands/              project prompts
 *   ./.trayambak/commands/   project prompts (namespaced dir)
 *   ~/.trayambak/commands/   user-wide prompts
 *
 * becomes `/name` in the composer. The body is a PROMPT TEMPLATE: it expands
 * with the typed arguments (`$ARGUMENTS`, `$1..$9`) and is submitted as a
 * normal prompt — the model runs it, there is no code execution here.
 *
 * First directory wins on a name collision, so `./commands` beats
 * `.trayambak/commands` beats the user-wide dir (project beats user).
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface PromptCommand {
  /** Slash name without the "/"; nested files keep their path (`review/pr`). */
  name: string
  description: string
  argumentHint?: string
  /** Template body — front-matter stripped, ready for expansion. */
  body: string
  file: string
}

const MD_EXT_LENGTH = 3 // ".md"

/** Search paths in precedence order (first wins a name collision). */
export function defaultPromptCommandDirs(cwd: string, home: string = os.homedir()): string[] {
  return [
    path.join(cwd, "commands"),
    path.join(cwd, ".trayambak", "commands"),
    path.join(home, ".trayambak", "commands"),
  ]
}

/**
 * Lenient parse: optional `---` front-matter carries `description` /
 * `argument-hint`; without front-matter the first heading (or first non-empty
 * line) becomes the description and the whole file is the body. Returns null
 * for files with no usable content at all.
 */
export function parsePromptFile(raw: string): { description: string; argumentHint?: string; body: string } | null {
  const text = raw.replace(/^\uFEFF/, "")
  let body = text
  let description = ""
  let argumentHint: string | undefined

  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (fm) {
    for (const line of (fm[1] ?? "").split(/\r?\n/)) {
      const idx = line.indexOf(":")
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim().toLowerCase()
      const value = line.slice(idx + 1).trim()
      if ((key === "description" || key === "desc") && value) description = value
      else if ((key === "argument-hint" || key === "argumenthint" || key === "usage") && value) argumentHint = value
    }
    body = fm[2] ?? ""
  } else {
    const heading = text.match(/^#{1,6}\s+(.+)$/m)
    if (heading?.[1]) {
      description = heading[1].trim()
    } else {
      const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0)
      if (firstLine) description = firstLine.trim().slice(0, 100)
    }
  }

  body = body.trim()
  if (!body && !description) return null
  if (!description) description = body.slice(0, 100)
  return { description, argumentHint, body }
}

/** Depth-capped recursive `*.md` walk (skips dot/node_modules subdirs). */
function* walkMarkdownFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 5) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue
      yield* walkMarkdownFiles(full, depth + 1)
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      yield full
    }
  }
}

/** Load every `*.md` under one directory; name = relative path minus `.md`. */
export function loadPromptCommandsFromDir(dir: string): PromptCommand[] {
  if (!dir) return []
  const out: PromptCommand[] = []
  for (const file of walkMarkdownFiles(dir)) {
    try {
      const parsed = parsePromptFile(fs.readFileSync(file, "utf8"))
      if (!parsed) continue
      const rel = path.relative(dir, file).split(path.sep).join("/")
      out.push({ name: rel.slice(0, -MD_EXT_LENGTH), file, ...parsed })
    } catch {
      /* unreadable/malformed file — skip */
    }
  }
  return out
}

/** Load all directories in precedence order; first definition of a name wins. */
export function loadPromptCommands(dirs: readonly string[]): PromptCommand[] {
  const byName = new Map<string, PromptCommand>()
  for (const dir of dirs) {
    for (const cmd of loadPromptCommandsFromDir(dir)) {
      const key = cmd.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, cmd)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * SKT AI LABS/Roo placeholder expansion: `$ARGUMENTS` = everything after the command
 * name; `$1..$9…` = positional words, multi-digit included (missing →
 * empty); `$$` = literal `$`. Single pass, so no sentinel is needed.
 *
 * Fixed three bugs in the old chained replaces: `$10` expanded as `$1`
 * followed by a literal "0"; case-insensitive `$ARGUMENTS` rewrote prose
 * like "$arguments"; and the NUL sentinel corrupted bodies containing a
 * real NUL. `$ARGUMENTS` is case-EXACT (uppercase); `$0`, `$foo`, and a
 * trailing `$` pass through untouched, as before.
 */
export function expandPromptCommand(body: string, argsString: string): string {
  const args = (argsString ?? "").trim()
  const parts = args ? args.split(/\s+/) : []
  return body.replace(/\$(\$|ARGUMENTS|[1-9]\d*)/g, (m, tok: string) => {
    if (tok === "$") return "$"
    if (tok === "ARGUMENTS") return args
    return parts[parseInt(tok, 10) - 1] ?? ""
  })
}
