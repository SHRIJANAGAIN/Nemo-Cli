/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * `.agentignore` — per-project credential deny-list (the `.claudeignore`
 * convention, Trayambak-flavoured).
 *
 * One glob per line in `<cwd>/.agentignore` (`#` comments, blank lines
 * ignored). Patterns become config-layer DENY rules, so deny beats allow
 * everywhere the ladder runs (read tools, bash, MCP) except explicit
 * full-access, which bypasses all layers by design.
 *
 * Matching semantics (inherited from the rule engine, unanchored +
 * case-insensitive): a pattern matches ANY subject containing it, whether
 * the tool was handed an absolute or relative path — so `*.pem` covers
 * `/etc/ssl/x.pem` too. Backslash variants are emitted for patterns with
 * `/` so Windows subjects match as well.
 *
 * NOT supported in v1: `!` negation lines are ignored (documented, not
 * silently half-honored — the engine checks deny before allow within a
 * layer, so an allow-exception could never win anyway).
 */

import * as fs from "fs"
import * as path from "path"
import type { PermissionRuleV2 } from "../../../packages/protocol/src/permissions.js"

export const AGENTIGNORE_FILE = ".agentignore"

/** Hygiene cap: a deny-list bigger than this is a misconfiguration. */
export const AGENTIGNORE_MAX_LINES = 100

/** Parse file text into deny patterns (no fs — pure, unit-tested). */
export function parseAgentignore(text: string): string[] {
  const out: string[] = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue
    if (out.length >= AGENTIGNORE_MAX_LINES) break
    out.push(line)
  }
  return out
}

/** Read `<cwd>/.agentignore` ([] when absent/unreadable — never throws). */
export function loadAgentignorePatterns(cwd: string): string[] {
  try {
    return parseAgentignore(fs.readFileSync(path.join(cwd, AGENTIGNORE_FILE), "utf8"))
  } catch {
    return []
  }
}

/** Map patterns to config-layer deny rules for the permission ladder. */
export function agentignoreDenyRules(cwd: string): PermissionRuleV2[] {
  const rules: PermissionRuleV2[] = []
  for (const pattern of loadAgentignorePatterns(cwd)) {
    const reason = `${AGENTIGNORE_FILE}: ${pattern}`
    rules.push({ tool: "*", pattern, action: "deny", reason })
    if (pattern.includes("/")) {
      rules.push({ tool: "*", pattern: pattern.replace(/\//g, "\\"), action: "deny", reason })
    }
  }
  return rules
}
