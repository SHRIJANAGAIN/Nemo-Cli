/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const RULE_FILENAMES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

interface RuleFile {
  path: string
  name: string
  content: string
  origin: "project" | "global"
}

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

export function loadRules(cwd: string): RuleFile[] {
  const rules: RuleFile[] = []
  const seen = new Set<string>()

  const projectFiles = findUp(cwd, RULE_FILENAMES)
  for (const filePath of projectFiles) {
    const resolved = path.resolve(filePath)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    try {
      const content = fs.readFileSync(resolved, "utf8")
      rules.push({ path: resolved, name: path.basename(resolved), content, origin: "project" })
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
          rules.push({ path: resolved, name, content, origin: "global" })
        } catch {
          /* skip unreadable files */
        }
      }
    }
  }

  return rules
}

export function getRulesContextBlock(cwd: string): string {
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

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__Rules",
  description:
    "Manage project rules from AGENTS.md/CLAUDE.md/CONTEXT.md files. Read existing rules, write new rules, list available rules, or initialize a default AGENTS.md for the project.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["read", "write", "list", "init"],
        description: "The operation to perform on rules.",
      },
      name: { type: "string", description: "Rule file name for read/write (e.g., 'AGENTS.md')." },
      content: { type: "string", description: "Content to write (for 'write' action)." },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "Scope for the rule file (default 'project').",
      },
    },
  },
}

export function createRulesTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const action = String(args.action ?? "")
      const cwd = context?.cwd ?? process.cwd()
      const name = String(args.name ?? "AGENTS.md")

      switch (action) {
        case "read": {
          const rules = loadRules(cwd)
          const rule = rules.find((r) => r.name === name)
          if (!rule)
            return textResult(`No rule file '${name}' found. Use 'list' to see available rules.`, /*isError*/ true)
          return textResult(rule.content)
        }

        case "list": {
          const rules = loadRules(cwd)
          if (rules.length === 0) return textResult("No rule files found (AGENTS.md, CLAUDE.md, CONTEXT.md).")
          const lines = rules.map(
            (r) =>
              `${r.origin === "project" ? "project" : "global"}: ${r.name} — ${r.path} (${r.content.length} chars)`,
          )
          return textResult(lines.join("\n"))
        }

        case "write": {
          const content = String(args.content ?? "")
          if (!content) return textResult("Missing 'content' for write action.", /*isError*/ true)
          const scope = (args.scope as string) === "global" ? "global" : "project"
          let targetDir: string
          if (scope === "global") {
            targetDir = path.join(os.homedir(), ".trayambak")
          } else {
            targetDir = cwd
          }
          fs.mkdirSync(targetDir, { recursive: true })
          const filePath = path.join(targetDir, name)
          fs.writeFileSync(filePath, content, "utf8")
          return textResult(`Rule written to: ${filePath}`)
        }

        case "init": {
          const filePath = path.join(cwd, "AGENTS.md")
          if (fs.existsSync(filePath)) return textResult("AGENTS.md already exists in the project root.")
          const content = `# Trayambak Project Rules

## Project Info
- Project: trayambak
- Brand: trayambak by SKT AI LABS PRIVATE LIMITED

## Coding Standards
- Follow existing code conventions and patterns
- Write clean, maintainable code
- Prefer smallest correct change

## Commands
- \`npm run build\` — compile TypeScript
- \`npm run typecheck\` — type-check without emitting
- \`npx vitest run\` — run tests

## Git Workflow
- Commit only when explicitly asked
- Review before committing
`
          fs.writeFileSync(filePath, content, "utf8")
          return textResult(`Created default AGENTS.md at: ${filePath}`)
        }

        default:
          return textResult(`Unknown action: ${action}. Use read, write, list, or init.`, /*isError*/ true)
      }
    },
  }
}
