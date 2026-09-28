/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/** Granular auto-approval: prefix allow/deny + protected files. */

export interface ApprovalPolicy {
  allowedCommands: string[]
  deniedCommands: string[]
  protectedPatterns: string[]
}

export const DEFAULT_APPROVAL: ApprovalPolicy = {
  allowedCommands: ["git log", "git diff", "git show"],
  deniedCommands: [],
  protectedPatterns: [".trayambakignore", ".roomodes", ".trayambak/**", "AGENTS.md"],
}

function matchesPrefix(cmd: string, prefix: string): boolean {
  if (prefix === "*") return true
  if (prefix.endsWith("*")) return cmd.startsWith(prefix.slice(0, -1))
  return cmd === prefix || cmd.startsWith(prefix + " ") || cmd.startsWith(prefix + "\t")
}

export function checkAutoApproval(
  command: string,
  policy: ApprovalPolicy = DEFAULT_APPROVAL,
): "allow" | "deny" | "ask" {
  for (const d of policy.deniedCommands) {
    if (matchesPrefix(command.trim(), d.trim())) return "deny"
  }
  for (const a of policy.allowedCommands) {
    if (matchesPrefix(command.trim(), a.trim())) return "allow"
  }
  return "ask"
}

export function isProtectedFile(file: string, policy: ApprovalPolicy = DEFAULT_APPROVAL): boolean {
  const norm = file.replace(/\\/g, "/")
  return policy.protectedPatterns.some((p) => {
    if (p.endsWith("/**")) return norm.startsWith(p.slice(0, -3))
    return norm === p || norm.endsWith("/" + p)
  })
}
