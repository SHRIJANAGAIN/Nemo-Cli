/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Permission ruleset engine (ported from SKT AI LABS Code's permission system).
 *
 * Layers, highest precedence first:
 *   1. full-access mode — nothing blocks, everything is allowed. The user
 *                        explicitly asked to run unguarded.
 *   2. session rules   — "always/never for this session", in-memory
 *   3. config rules    — rulesV2, persisted in the user's config
 *   4. legacy rules    — the original {tool, pattern, allow} defaults
 *   5. force-ask rules — destructive operations that require a human even
 *                        under auto-approve (bypassed only by full-access)
 *   6. UI mode         — read-only | ask | auto-approve | full-access
 *
 * Within layers 2–4, deny beats allow (hard veto). Full-access skips all
 * layers. In auto-approve, only DELETE-family operations can still ask —
 * everything else auto-allows.
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
  // ── recursive / forced delete ───────────────────────────���─────────────
  { tool: "*", pattern: "rm -rf", action: "ask", reason: "recursive force delete" },
  { tool: "*", pattern: "rm -fr", action: "ask", reason: "recursive force delete" },
  { tool: "*", pattern: "del /s /q", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "Remove-Item -Recurse -Force", action: "ask", reason: "recursive delete (PowerShell)" },
  { tool: "*", pattern: "rmdir /s", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "rd /s /q", action: "ask", reason: "recursive delete (Windows)" },
  { tool: "*", pattern: "find / -delete", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean -fdx", action: "ask", reason: "recursive delete" },
  { tool: "*", pattern: "git clean -fd", action: "ask", reason: "recursive delete" },

  // ── privilege escalation ─────────────────────────────────────────────
  { tool: "*", pattern: "sudo ", action: "ask", reason: "privilege escalation" },
  { tool: "*", pattern: "su -", action: "ask", reason: "privilege escalation" },
  { tool: "*", pattern: "doas ", action: "ask", reason: "privilege escalation" },
  { tool: "*", pattern: "runas ", action: "ask", reason: "privilege escalation (Windows)" },
  { tool: "*", pattern: "Start-Process -Verb RunAs", action: "ask", reason: "privilege escalation (PowerShell)" },

  // ── system power / reboot ───────────────────────────────────────────
  { tool: "*", pattern: "shutdown", action: "ask", reason: "system power" },
  { tool: "*", pattern: "reboot", action: "ask", reason: "system power" },
  { tool: "*", pattern: "poweroff", action: "ask", reason: "system power" },
  { tool: "*", pattern: "halt ", action: "ask", reason: "system power" },
  { tool: "*", pattern: "Stop-Computer", action: "ask", reason: "system power (PowerShell)" },
  { tool: "*", pattern: "systemctl poweroff", action: "ask", reason: "system power" },
  { tool: "*", pattern: "systemctl reboot", action: "ask", reason: "system power" },

  // ── filesystem / disk destruction ───────────────────────────────────
  { tool: "*", pattern: "mkfs", action: "ask", reason: "filesystem format" },
  { tool: "*", pattern: "format ", action: "ask", reason: "disk format" },
  { tool: "*", pattern: "format.com", action: "ask", reason: "disk format (Windows)" },
  { tool: "*", pattern: "dd if=", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "of=/dev/", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "> /dev/sd", action: "ask", reason: "raw disk write" },
  { tool: "*", pattern: "fdisk", action: "ask", reason: "partition table write" },
  { tool: "*", pattern: "parted", action: "ask", reason: "partition table write" },
  { tool: "*", pattern: "diskpart", action: "ask", reason: "partition table write (Windows)" },
  { tool: "*", pattern: "shred ", action: "ask", reason: "irreversible erase" },
  { tool: "*", pattern: "chmod -R 777", action: "ask", reason: "permission destruction" },
  { tool: "*", pattern: "chmod 777 /", action: "ask", reason: "permission destruction" },
  { tool: "*", pattern: "chown -R", action: "ask", reason: "ownership rewrite" },
  { tool: "*", pattern: "takeown", action: "ask", reason: "ownership rewrite (Windows)" },
  { tool: "*", pattern: "icacls", action: "ask", reason: "ACL rewrite (Windows)" },
  { tool: "*", pattern: "reg delete", action: "ask", reason: "registry deletion" },
  { tool: "*", pattern: "vssadmin", action: "ask", reason: "shadow copy deletion" },
  { tool: "*", pattern: "wmic shadowcopy delete", action: "ask", reason: "shadow copy deletion" },

  // ── force push / history rewriting ──────────────────────────────────
  { tool: "*", pattern: "git push --force", action: "ask", reason: "force push" },
  { tool: "*", pattern: "git push -f", action: "ask", reason: "force push" },
  { tool: "*", pattern: "git push origin", action: "ask", reason: "remote mutation" },
  { tool: "*", pattern: "git reset --hard", action: "ask", reason: "discard working tree" },
  { tool: "*", pattern: "git filter-branch", action: "ask", reason: "history rewrite" },
  { tool: "*", pattern: "git update-ref -d", action: "ask", reason: "history rewrite" },

  // ── pipe-to-shell / remote code execution ───────────────────────────
  { tool: "*", pattern: " | sh", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: " | bash", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: "|zsh", action: "ask", reason: "pipe-to-shell download" },
  { tool: "*", pattern: "|python", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "|node", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "| perl", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "| ruby", action: "ask", reason: "pipe-to-interpreter" },
  { tool: "*", pattern: "iex ", action: "ask", reason: "PowerShell Invoke-Expression download" },
  { tool: "*", pattern: "Invoke-Expression", action: "ask", reason: "PowerShell Invoke-Expression download" },
  { tool: "*", pattern: "iwr ", action: "ask", reason: "PowerShell web request download" },
  { tool: "*", pattern: "Invoke-WebRequest", action: "ask", reason: "PowerShell web request download" },
  { tool: "*", pattern: "wget http", action: "ask", reason: "remote download" },
  { tool: "*", pattern: "curl http", action: "ask", reason: "remote download" },
  { tool: "*", pattern: "eval(", action: "ask", reason: "dynamic evaluation" },

  // ── anti-forensics / evidence destruction ───────────────────────────
  { tool: "*", pattern: "history -c", action: "ask", reason: "shell history erasure" },
  { tool: "*", pattern: "> .bash_history", action: "ask", reason: "shell history erasure" },
  { tool: "*", pattern: "Clear-Content", action: "ask", reason: "log truncation (PowerShell)" },
  { tool: "*", pattern: "> /var/log", action: "ask", reason: "system log truncation" },
  { tool: "*", pattern: "truncate -s 0", action: "ask", reason: "file truncation" },
  { tool: "*", pattern: "Remove-Message", action: "ask", reason: "audit log deletion (PowerShell)" },
  { tool: "*", pattern: "wevtutil cl", action: "ask", reason: "audit log deletion (Windows)" },

  // ── irreversible data / infrastructure loss ─────────────────────────
  { tool: "*", pattern: "DROP DATABASE", action: "ask", reason: "database destruction" },
  { tool: "*", pattern: "DROP TABLE", action: "ask", reason: "table destruction" },
  { tool: "*", pattern: "TRUNCATE TABLE", action: "ask", reason: "table destruction" },
  { tool: "*", pattern: "db.dropDatabase", action: "ask", reason: "database destruction" },
  { tool: "*", pattern: "DROP SCHEMA", action: "ask", reason: "schema destruction" },
  { tool: "*", pattern: "docker system prune", action: "ask", reason: "container destruction" },
  { tool: "*", pattern: "docker volume rm", action: "ask", reason: "volume destruction" },
  { tool: "*", pattern: "terraform destroy", action: "ask", reason: "infrastructure destruction" },
  { tool: "*", pattern: "terraform apply", action: "ask", reason: "infrastructure mutation" },
  { tool: "*", pattern: "kubectl delete", action: "ask", reason: "cluster destruction" },
  { tool: "*", pattern: "aws s3 rb", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "gsutil rm -r", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "az storage delete", action: "ask", reason: "cloud storage destruction" },
  { tool: "*", pattern: "helm delete", action: "ask", reason: "cluster destruction" },
  { tool: "*", pattern: "DROP VOLUME", action: "ask", reason: "volume destruction" },

  // ── credential / secret access ─────────────────────────────────────
  { tool: "*", pattern: "cat ~/.ssh", action: "ask", reason: "private key read" },
  { tool: "*", pattern: "cat /etc/shadow", action: "ask", reason: "credential read" },
  { tool: "*", pattern: "cat .aws/credentials", action: "ask", reason: "cloud credential read" },
  { tool: "*", pattern: "printenv", action: "ask", reason: "environment dump" },
  { tool: "*", pattern: "env | grep", action: "ask", reason: "environment dump" },
  { tool: "*", pattern: "setx", action: "ask", reason: "persistent env mutation (Windows)" },
]

/**
 * Irreversible-action subset of FORCE_ASK_RULES — the rules that still gate
 * a tool call under auto-approve mode.
 *
 * Auto-approve exists to stop *routine* work from prompting, not to hand the
 * agent a blank cheque. So the gate covers every action whose damage is
 * unrecoverable or unauditable: deleting data, destroying infrastructure,
 * erasing evidence, and executing code that has not been read yet.
 *
 * Deliberately NOT in this set (they still ask in the default `ask` mode, but
 * auto-approve lets them through because they are recoverable or routine):
 *   - privilege escalation (`sudo`, `doas`, `runas`) — noisy, and the
 *     escalation itself fails without real credentials;
 *   - force push / `git reset --hard` — recoverable from the reflog;
 *   - raw disk writes and permission churn outside the delete families;
 *   - credential *reads* (`cat ~/.ssh/id_rsa`, `printenv`) — these are
 *     read-only, and the network-deny sandbox plus secret redaction are the
 *     controls that actually limit exfiltration.
 *
 * full-access mode bypasses the whole set by explicit user choice.
 */
export const IRREVERSIBLE_FORCE_ASK_REASONS: ReadonlySet<string> = new Set([
  // deletion
  "recursive force delete",
  "recursive delete (Windows)",
  "recursive delete (PowerShell)",
  "disk format",
  "filesystem format",
  "partition table write",
  "partition table write (Windows)",
  "raw disk write",
  "database destruction",
  "table destruction",
  "schema destruction",
  "volume destruction",
  "container destruction",
  "infrastructure destruction",
  "cluster destruction",
  "cloud storage destruction",
  "irreversible erase",
  "permission destruction",
  "registry deletion",
  "shadow copy deletion",
  "audit log deletion (PowerShell)",
  "audit log deletion (Windows)",
  "shell history erasure",
  "system log truncation",
  "log truncation (PowerShell)",
  "file truncation",
  "ownership rewrite",
  "ownership rewrite (Windows)",
  "ACL rewrite (Windows)",
  "pipe-to-shell download",
  "pipe-to-interpreter",
  "PowerShell web request download",
  "PowerShell Invoke-Expression download",
  "remote download",
  "dynamic evaluation",
  "persistent env mutation (Windows)",
])

/**
 * Delete-family subset of FORCE_ASK_RULES, retained under its original name
 * because it is the historical export. In auto-approve mode ONLY these can
 * still gate a tool call — every other sensitive operation auto-allows.
 */
export const DELETE_FORCE_ASK_RULES: ReadonlyArray<PermissionRuleV2> = FORCE_ASK_RULES.filter((r) =>
  IRREVERSIBLE_FORCE_ASK_REASONS.has(r.reason ?? ""),
)

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
  const uiMode = options?.uiMode ?? deriveUIMode(config)

  // 0) Full-access: nothing blocks, everything is allowed. The user
  //    explicitly chose to run unguarded — no rule layer applies.
  if (uiMode === "full-access") {
    return { action: "allow", source: "mode", layer: "mode" }
  }

  // 1) Rule layers, highest precedence first: session > config > default.
  //    Within a layer, deny beats allow (hard veto). A higher layer's
  //    explicit allow can therefore override a lower layer's default deny —
  //    that is exactly what "always allow" is for.
  //    Auto-approve skips the STOCK default layer: the user accepted risk
  //    for everything except deletes, but their own session/config rules
  //    stay sacred and still gate.
  const layers: Array<[PermissionLayer, PermissionRuleV2[]]> =
    uiMode === "auto-approve"
      ? [
          ["session", [...sessionRules]],
          ["config", [...(config.rulesV2 ?? [])]],
        ]
      : [
          ["session", [...sessionRules]],
          ["config", [...(config.rulesV2 ?? [])]],
          ["default", legacyToRules(config.rules ?? [])],
        ]
  const matches = (rule: PermissionRuleV2): boolean => matchTool(tool, rule.tool) && matchSubject(subject, rule.pattern)
  for (const [layer, rules] of layers) {
    const deny = rules.find((r) => r.action === "deny" && matches(r))
    if (deny) return { action: "deny", source: "deny-rule", rule: deny, layer }
    const allow = rules.find((r) => r.action === "allow" && matches(r))
    if (allow) return { action: "allow", source: "allow-rule", rule: allow, layer }
  }

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

  // 5) Force-ask: in auto-approve mode ONLY delete-family operations can
  //    still gate a call — everything else auto-allows. (Full-access never
  //    reaches here: it returns allow at step 0.)
  const forcePool = uiMode === "auto-approve" ? DELETE_FORCE_ASK_RULES : FORCE_ASK_RULES
  const force = forcePool.find((r) => matchTool(tool, r.tool) && matchSubject(subject, r.pattern))
  if (force) {
    return { action: "ask", source: "force-ask", rule: force, layer: "force-ask" }
  }

  // 6) Mode defaults. (Full-access never reaches here: step 0.)
  if (uiMode === "auto-approve") {
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
