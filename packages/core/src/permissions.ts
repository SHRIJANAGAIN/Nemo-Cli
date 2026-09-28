/* Copyright 2026 SKT AI LABS PRIVATE LIMITED.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Permission rule engine — `Tool(glob)` syntax plus a denial tracker.
 *
 * Rules are authored as `ToolName(subject-glob)` strings, e.g.
 * `Bash(npm test)`, `Write(src/**)`, `*(rm -rf *)`. Evaluation is
 * deny-first: any matching deny rule wins over allows. No match means
 * the caller decides (agent loop treats it as `ask`).
 *
 * This is the runtime engine; the persisted shapes live in
 * `packages/protocol/src/permissions.ts` (PermissionRuleV2).
 */

export type PermissionVerdict = "allow" | "deny" | "ask"

export interface ParsedRule {
  tool: string
  pattern: string
  allow: boolean
  source: string
}

/** Parse `Tool(glob)` or `!Tool(glob)` (leading `!` = deny). Bare names match any subject. */
export function parseRule(source: string, allowDefault = true): ParsedRule | null {
  const text = source.trim()
  if (!text || text.startsWith("#")) return null
  let allow = allowDefault
  let rest = text
  if (rest.startsWith("!")) {
    allow = false
    rest = rest.slice(1).trim()
  }
  const open = rest.indexOf("(")
  if (open === -1) {
    if (!rest) return null
    return { tool: rest, pattern: "*", allow, source: text }
  }
  if (!rest.endsWith(")")) return null
  const tool = rest.slice(0, open).trim()
  const pattern = rest.slice(open + 1, -1).trim() || "*"
  if (!tool) return null
  return { tool, pattern, allow, source: text }
}

function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${esc}$`, "s")
}

function toolMatches(ruleTool: string, tool: string): boolean {
  if (ruleTool === "*") return true
  return globToRegExp(ruleTool).test(tool)
}

function subjectMatches(pattern: string, subject: string): boolean {
  if (pattern === "" || pattern === "*") return true
  if (globToRegExp(pattern).test(subject)) return true
  // Substring fallback mirrors PermissionRuleV2 semantics in protocol.
  return subject.includes(pattern.replace(/\*/g, ""))
}

/** Deny-first evaluation over parsed rules. Returns `ask` on no match. */
export function decidePermission(rules: ParsedRule[], tool: string, subject: string): PermissionVerdict {
  let allowed = false
  for (const rule of rules) {
    if (!toolMatches(rule.tool, tool)) continue
    if (!subjectMatches(rule.pattern, subject)) continue
    if (!rule.allow) return "deny"
    allowed = true
  }
  return allowed ? "allow" : "ask"
}

/** Parse a rule list, skipping blanks/comments/invalid lines. */
export function parseRules(sources: string[], allowDefault = true): ParsedRule[] {
  const out: ParsedRule[] = []
  for (const s of sources) {
    const parsed = parseRule(s, allowDefault)
    if (parsed) out.push(parsed)
  }
  return out
}

/** Denial tracker — counts denials per tool for telemetry and backoff. */
export class DenialTracker {
  private readonly counts = new Map<string, number>()
  private lastDeniedAt = 0

  /** Record a denial. Returns the new count for that tool. */
  record(tool: string): number {
    const next = (this.counts.get(tool) ?? 0) + 1
    this.counts.set(tool, next)
    this.lastDeniedAt = Date.now()
    return next
  }

  count(tool: string): number {
    return this.counts.get(tool) ?? 0
  }

  total(): number {
    let sum = 0
    for (const n of this.counts.values()) sum += n
    return sum
  }

  getLastDeniedAt(): number {
    return this.lastDeniedAt
  }

  reset(tool?: string): void {
    if (tool === undefined) {
      this.counts.clear()
      this.lastDeniedAt = 0
      return
    }
    this.counts.delete(tool)
  }
}
