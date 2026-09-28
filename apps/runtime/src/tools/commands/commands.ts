/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export interface CommandSpec {
  name: string
  description: string
  argumentHint?: string
  body: string
  file: string
}

export function defaultCommandsDir(): string {
  return path.join(process.cwd(), "commands")
}

export function loadCommandsFromDir(dir: string): CommandSpec[] {
  if (!dir || !fs.existsSync(dir)) return []
  const out: CommandSpec[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue
    const full = path.join(dir, e.name)
    try {
      const raw = fs.readFileSync(full, "utf8")
      const spec = parseCommandFile(raw, full)
      if (spec) out.push(spec)
    } catch {
      /* skip malformed command */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function parseCommandFile(raw: string, file: string): CommandSpec | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) return null
  const front = new Map<string, string>()
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^\s*([^:]+):\s*(.*?)\s*$/)
    if (kv) front.set(kv[1], kv[2].replace(/^["']|["']$/g, ""))
  }
  const name = path.basename(file, path.extname(file))
  const description = front.get("description") ?? ""
  const argumentHint = front.get("argument-hint") ?? ""
  const body = m[2].trim()
  if (!name) return null
  return {
    name,
    description,
    argumentHint: argumentHint || undefined,
    body,
    file,
  }
}

export function defaultRulesDir(): string {
  return path.join(process.cwd(), ".trayambak", "rules")
}

export function loadRulesFromDir(dir: string): string[] {
  if (!dir || !fs.existsSync(dir)) return []
  const out: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue
    const full = path.join(dir, e.name)
    try {
      const raw = fs.readFileSync(full, "utf8")
      const title = path.basename(e.name, path.extname(e.name))
      out.push(`### ${title}\n${raw.trim()}`)
    } catch {
      /* skip unreadable rule file */
    }
  }
  return out.sort()
}

export function rulesBlock(rules: string[]): string {
  if (!rules || rules.length === 0) return ""
  return ["Rules (from .trayambak/rules):", ...rules].join("\n")
}
