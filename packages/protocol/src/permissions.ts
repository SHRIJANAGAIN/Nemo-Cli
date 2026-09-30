/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export type AgentMode = "default" | "coder" | "yolo" | "browser" | "planner"

export type PermissionAction = "allow" | "ask" | "deny"

export interface PermissionRule {
  tool: string
  pattern: string
  allow: boolean
}

/** Tri-state wildcard rule (SKT AI LABS-style). Evaluated layer by layer, first match wins. */
export interface PermissionRuleV2 {
  /** Tool name glob — "*" matches every tool, "write_*" matches prefixed tools. */
  tool: string
  /** Subject glob matched (as a substring) against the command/path of the call. Empty or "*" matches everything. */
  pattern?: string
  action: PermissionAction
  /** Optional human-readable justification, shown in rule listings. */
  reason?: string
}

/** Active interactive UI permission mode, synced from the TUI into the agent config. */
export type PermissionUIMode = "read-only" | "plan" | "ask" | "auto-approve" | "full-access"

export interface PermissionConfig {
  mode: AgentMode
  rules: PermissionRule[]
  askByDefault: boolean
  /** User-authored tri-state rules (persisted via `trayambak config set`). Evaluated before the legacy rules. */
  rulesV2?: PermissionRuleV2[]
  /** Live UI mode (read-only | plan | ask | auto-approve | full-access). Set by the TUI at runtime. */
  uiMode?: PermissionUIMode
}

export const DEFAULT_PERMISSIONS: PermissionConfig = {
  mode: "default",
  rules: [
    { tool: "bash", pattern: "rm -rf /", allow: false },
    { tool: "bash", pattern: "rm -rf ~", allow: false },
    { tool: "bash", pattern: "rm -rf .", allow: false },
    { tool: "bash", pattern: "del /s /q", allow: false },
    { tool: "bash", pattern: "format", allow: false },
    { tool: "bash", pattern: "shutdown", allow: false },
    { tool: "bash", pattern: "reboot", allow: false },
    { tool: "bash", pattern: "sudo", allow: false },
    { tool: "bash", pattern: "su ", allow: false },
  ],
  askByDefault: true,
}

/** Read-only tools never need approval — they cannot mutate anything. */
export const READ_ONLY_TOOLS = new Set<string>([
  "read_file",
  "list_dir",
  "glob",
  "grep",
  "code_search",
  "read_manifest",
  "web_search",
  "web_fetch",
  "web_browse",
  "memory",
  "todo",
  "summarize",
  "extract",
  "diff",
  "csv",
  "yaml",
  "artifact",
  "get_mode",
  "tool_search",
])

/** Check ONLY the explicit deny rules (e.g. "rm -rf /"). No default-deny. */
export function isCommandDangerous(tool: string, command: string, config: PermissionConfig): boolean {
  for (const rule of config.rules) {
    if ((rule.tool === tool || rule.tool === "*") && !rule.allow) {
      if (rule.pattern === "*") return true
      const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s/g, "\\s+")
      if (new RegExp(`\\b${escaped}`, "i").test(command)) return true
    }
  }
  return false
}

export function isCommandAllowed(tool: string, command: string, config: PermissionConfig): boolean {
  // Explicit deny rules always win (rm -rf, shutdown, etc.)
  if (isCommandDangerous(tool, command, config)) return false
  // Read-only tools are always safe
  if (READ_ONLY_TOOLS.has(tool)) return true
  // Everything else (bash, write_file, edit_file...) needs approval
  // unless askByDefault is disabled (yolo mode).
  return config.askByDefault ? false : true
}

export function isYoloMode(config: PermissionConfig): boolean {
  return config.mode === "yolo" || config.askByDefault === false
}

export function togglePermissionMode(config: PermissionConfig): PermissionConfig {
  const yolo = isYoloMode(config)
  return { ...config, mode: (yolo ? "default" : "yolo") as AgentMode, askByDefault: yolo ? true : false }
}

export function getPermissionBadge(config: PermissionConfig): string {
  return isYoloMode(config) ? "YOLO" : "ASK"
}

export function getPermissionModeLabel(config: PermissionConfig): string {
  return isYoloMode(config) ? "FULL" : "ASK"
}
