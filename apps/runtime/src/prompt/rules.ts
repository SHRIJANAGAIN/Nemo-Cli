/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"

export interface RuleFile {
  path: string
  name: string
  content: string
  origin: "project" | "global" | "workspace"
}

const RULE_FILENAMES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

function findUp(dir: string, names: string[], maxDepth: number = 16): string[] {
  const results: string[] = []
  let current = dir
  for (let i = 0; i < maxDepth; i++) {
    for (const name of names) {
      const fullPath = path.join(current, name)
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        results.push(fullPath)
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return results
}

export function loadRules(cwd: string = process.cwd()): RuleFile[] {
  const rules: RuleFile[] = []
  const seen = new Set<string>()

  const projectFiles = findUp(cwd, RULE_FILENAMES)
  for (const filePath of projectFiles) {
    const resolved = path.resolve(filePath)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    try {
      const content = fs.readFileSync(resolved, "utf8")
      rules.push({
        path: resolved,
        name: path.basename(resolved),
        content,
        origin: "project",
      })
    } catch {
      /* skip unreadable files */
    }
  }

  const globalDir = path.join(os.homedir(), ".trayambak")
  if (fs.existsSync(globalDir)) {
    for (const name of RULE_FILENAMES) {
      const filePath = path.join(globalDir, name)
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const resolved = path.resolve(filePath)
        if (seen.has(resolved)) continue
        seen.add(resolved)
        try {
          const content = fs.readFileSync(resolved, "utf8")
          rules.push({
            path: resolved,
            name,
            content,
            origin: "global",
          })
        } catch {
          /* skip unreadable files */
        }
      }
    }
  }

  return rules
}

export function getRulesContextBlock(cwd?: string): string {
  const rules = loadRules(cwd)
  if (rules.length === 0) return ""

  const blocks: string[] = ["## Project Rules (from AGENTS.md/CLAUDE.md/CONTEXT.md):"]
  for (const rule of rules) {
    blocks.push(`### From ${rule.name} (${rule.origin})`)
    blocks.push(rule.content.slice(0, 2000))
    if (rule.content.length > 2000) {
      blocks.push(`... [${rule.content.length - 2000} more chars truncated]`)
    }
  }
  return blocks.join("\n") + "\n"
}

export function getRulePaths(cwd?: string): string[] {
  return loadRules(cwd).map((r) => r.path)
}

export function writeRule(
  name: string,
  content: string,
  cwd: string = process.cwd(),
  scope: "project" | "global" = "project",
): string {
  const targetDir = scope === "global" ? path.join(os.homedir(), ".trayambak") : cwd
  fs.mkdirSync(targetDir, { recursive: true })
  const filePath = path.join(targetDir, name)
  fs.writeFileSync(filePath, content, "utf8")
  return filePath
}
