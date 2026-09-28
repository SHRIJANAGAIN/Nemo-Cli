/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Permission ruleset engine (ported from SKT AI LABS Code's permission system).
 *
 * Layers, highest precedence first:
 *   1. session rules   — "always/never for this session", in-memory
 *   2. config rules    — rulesV2, persisted in the user's config
 *   3. legacy rules    — the original {tool, pattern, allow} defaults
 *   4. force-ask rules — sensitive operations that always require a human
 *                        (bypassed only by explicit full-access / YOLO mode)
 *   5. UI mode         — read-only | ask | auto-approve | full-access
 *
 * Within a layer, deny beats allow (hard veto). A deny from any layer wins
 * outright; approvals can never override a deny rule.
 */

import {
  DEFAULT_PERMISSIONS,
  READ_ONLY_TOOLS,
  type PermissionAction,
  type PermissionConfig,
  type PermissionRule,
  type PermissionRuleV2,
  type PermissionUIMode,
} from "./permissions.js"

export type PermissionLayer = "session" | "config" | "default" | "force-ask" | "mode"

export type PermissionSource =
  "deny-rule" | "allow-rule" | "force-ask" | "read-only-mode" | "plan-mode" | "read-only-tool" | "mode" | "default"

export interface PermissionDecision {
  action: PermissionAction
  source: PermissionSource
  /** The rule that produced the decision, when a rule matched. */
  rule?: PermissionRuleV2
  layer?: PermissionLayer
}

/**
 * Operations that always require interactive approval — even under
 * auto-approve mode. Only an explicit full-access (YOLO) toggle bypasses
 * these, and a user can consciously allow-list them via config rules.
 */
export const FORCE_ASK_RULES: ReadonlyArray<PermissionRuleV2> = [
  { tool: "*", pattern: "rm -rf", action: "ask", reason: "recursive force delete" },
  { tool: "*", pattern: "sudo ", action: "ask", reason: "privilege escalation" },
  { tool: "*", pattern: "shutdown", action: "ask", reason: "system power" },
  { tool: "*", pattern: "reboot", action: "ask", reason: "system power" },
  { tool: "*", pattern: "mkfs", action: "ask", reason: "filesystem format" },
  { tool: "*", pattern: "dd if=", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "git push --force", action: "ask", reason: "force push" },
  { tool: "*", pattern: "git push -f", action: "ask", reason: "force push" },
  { tool: "*", pattern: "del /s /q", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "Remove-Item -Recurse -Force", action: "ask", reason: "recursive delete (PowerShell)" },
  { tool: "*", pattern: "format ", action: "ask", reason: "disk format" },
  { tool: "*", pattern: " | sh", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: " | bash", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: "iex ", action: "ask", reason: "PowerShell Invoke-Expression download" },
  { tool: "*", pattern: "Invoke-Expression", action: "ask", reason: "PowerShell Invoke-Expression download" },
]

/* ────────────────────────── session rule store ────────────────────────── */

let sessionRules: PermissionRuleV2[] = []

/** Add an in-memory rule that lives for this process/session only. */
export function addSessionPermissionRule(rule: PermissionRuleV2): void {
  // Later session decisions for the same tool+pattern replace earlier ones.
  sessionRules = sessionRules.filter((r) => !(r.tool === rule.tool && (r.pattern ?? "*") === (rule.pattern ?? "*")))
  sessionRules.unshift(rule)
}

export function clearSessionPermissionRules(): void {
  sessionRules = []
}

export function getSessionPermissionRules(): ReadonlyArray<PermissionRuleV2> {
  return sessionRules
}

/* ───────────────────────────── matching ───────────────────────────── */

function globToRegExp(pattern: string, anchored: boolean): RegExp {
  const body = pattern
    // escape regex specials except `*`, then turn `*` into `.*`
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
  return new RegExp(anchored ? `^${body}$` : body, "i")
}

function matchTool(tool: string, pattern: string): boolean {
  if (!pattern || pattern === "*") return true
  if (pattern.includes("*")) return globToRegExp(pattern, /*anchored*/ true).test(tool)
  return pattern.toLowerCase() === tool.toLowerCase()
}

function matchSubject(subject: string, pattern?: string): boolean {
  if (!pattern || pattern === "*") return true
  return globToRegExp(pattern, /*anchored*/ false).test(subject)
}

/**
 * Extract a human-friendly subject from tool arguments — the shell command,
 * the file path, the URL … Falls back to the JSON serialization.
 */
export function permissionSubject(args: unknown): string {
  if (typeof args === "string") return args
  if (args && typeof args === "object") {
    const obj = args as Record<string, unknown>
    for (const key of ["command", "path", "file_path", "filePath", "url", "query", "pattern"]) {
      const value = obj[key]
      if (typeof value === "string" && value.length > 0) return value
    }
    try {
      return JSON.stringify(args) ?? ""
    } catch {
      return String(args)
    }
  }
  return args == null ? "" : String(args)
}

function legacyToRules(rules: readonly PermissionRule[]): PermissionRuleV2[] {
  return rules.map((r) => ({
    tool: r.tool,
    pattern: r.pattern,
    action: r.allow ? ("allow" as const) : ("deny" as const),
  }))
}

function deriveUIMode(config: PermissionConfig): PermissionUIMode {
  if (config.uiMode) return config.uiMode
  // Legacy YOLO (mode "yolo" or askByDefault=false) ≈ auto-approve; deny
  // rules and force-ask still protect the user.
  if (config.mode === "yolo" || config.askByDefault === false) return "auto-approve"
  return "ask"
}

/* ─────────────────────────── evaluation ─────────────────────────── */

/**
 * Decide whether a tool call is allowed, must be asked about, or is denied.
 *
 * @param tool   tool name (e.g. "bash", "write_file")
 * @param args   raw tool arguments (or a pre-extracted subject string)
 * @param config effective permission config; defaults to DEFAULT_PERMISSIONS
 */
export function evaluatePermission(
  tool: string,
  args: unknown,
  config: PermissionConfig = DEFAULT_PERMISSIONS,
  options?: { uiMode?: PermissionUIMode },
): PermissionDecision {
  const subject = permissionSubject(args)
  const layers: Array<[PermissionLayer, PermissionRuleV2[]]> = [
    ["session", [...sessionRules]],
    ["config", [...(config.rulesV2 ?? [])]],
    ["default", legacyToRules(config.rules ?? [])],
  ]
  const matches = (rule: PermissionRuleV2): boolean => matchTool(tool, rule.tool) && matchSubject(subject, rule.pattern)

  // 1) Rule layers, highest precedence first: session > config > default.
  //    Within a layer, deny beats allow (hard veto). A higher layer's
  //    explicit allow can therefore override a lower layer's default deny —
  //    that is exactly what "always allow" is for.
  for (const [layer, rules] of layers) {
    const deny = rules.find((r) => r.action === "deny" && matches(r))
    if (deny) return { action: "deny", source: "deny-rule", rule: deny, layer }
    const allow = rules.find((r) => r.action === "allow" && matches(r))
    if (allow) return { action: "allow", source: "allow-rule", rule: allow, layer }
  }

  const uiMode = options?.uiMode ?? deriveUIMode(config)

  // 2) Read-only & plan mode: mutating tools are denied outright (and
  //    hidden from the model); only known-safe read-only tools pass.
  //    SKT AI LABS's plan mode is exactly this deny-list — the agent can explore
  //    but never modify — plus plan instructions appended to the system
  //    prompt by the agent loop, so it produces a plan for approval.
  if (uiMode === "read-only" || uiMode === "plan") {
    return READ_ONLY_TOOLS.has(tool)
      ? { action: "allow", source: "read-only-tool", layer: "mode" }
      : { action: "deny", source: uiMode === "plan" ? "plan-mode" : "read-only-mode", layer: "mode" }
  }

  // 3) Read-only tools never need approval.
  if (READ_ONLY_TOOLS.has(tool)) {
    return { action: "allow", source: "read-only-tool" }
  }

  // 5) Force-ask: sensitive operations require a human even under
  //    auto-approve. Only explicit full-access bypasses them.
  const force = FORCE_ASK_RULES.find((r) => matchTool(tool, r.tool) && matchSubject(subject, r.pattern))
  if (force) {
    if (uiMode === "full-access") return { action: "allow", source: "mode", rule: force, layer: "force-ask" }
    return { action: "ask", source: "force-ask", rule: force, layer: "force-ask" }
  }

  // 6) Mode defaults.
  if (uiMode === "auto-approve" || uiMode === "full-access") {
    return { action: "allow", source: "mode", layer: "mode" }
  }

  // 7) Ask mode (the default).
  return { action: "ask", source: "default", layer: "mode" }
}

/** True when the tool must never be executed (also used to hide tools from the model). */
export function isPermissionDenied(
  tool: string,
  args: unknown,
  config?: PermissionConfig,
  options?: { uiMode?: PermissionUIMode },
): boolean {
  return evaluatePermission(tool, args, config, options).action === "deny"
}
