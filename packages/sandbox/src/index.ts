/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Sandbox module — enhanced with OS-level enforcement types,
 * process spawning, violation detection, and environment filtering.
 *
 * This module provides the complete sandboxing infrastructure:
 * - Policy evaluation (original)
 * - OS-level sandbox types (NEW)
 * - Process spawning with sandbox enforcement (NEW)
 * - Violation detection and recording (NEW)
 * - Environment variable filtering (NEW)
 */

import * as fs from "fs"
import * as path from "path"

// ─── Original Policy Engine ───

export type SandboxPolicy =
  | { type: "danger-full-access" }
  | { type: "read-only"; networkAccess?: boolean }
  | { type: "workspace-write"; writableRoots: string[]; networkAccess?: boolean; readOnlySubpaths?: string[] }
  | { type: "external-sandbox"; networkAccess?: boolean }

export type SandboxBackend = "seatbelt" | "landlock" | "bwrap" | "windows-restricted" | "fallback"

export type EnforcementMode = "policy-only" | "os-sandbox"

export function detectBackend(): SandboxBackend {
  try {
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) return "seatbelt"
    if (process.platform === "linux" && fs.existsSync("/usr/bin/bwrap")) return "bwrap"
  } catch {
    /* ignore */
  }
  return "fallback"
}

export function enforcementFor(_backend: SandboxBackend): EnforcementMode {
  return "policy-only"
}

export interface SandboxCheck {
  allowed: boolean
  reason?: string
  backend: SandboxBackend
  enforcement: EnforcementMode
}

export function isPathInside(file: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file))
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function checkFileOp(policy: SandboxPolicy, op: "read" | "write", file: string, cwd: string): SandboxCheck {
  const backend = detectBackend()
  const enforcement = enforcementFor(backend)
  switch (policy.type) {
    case "danger-full-access":
      return { allowed: true, backend, enforcement }
    case "read-only":
      if (op === "read") return { allowed: true, backend, enforcement }
      return { allowed: false, reason: `read-only sandbox denies ${op} ${file}`, backend, enforcement }
    case "external-sandbox":
      return op === "read"
        ? { allowed: true, backend, enforcement }
        : { allowed: false, reason: "external sandbox denies writes", backend, enforcement }
    case "workspace-write": {
      if (op === "read") return { allowed: true, backend, enforcement }
      for (const sub of policy.readOnlySubpaths ?? []) {
        if (isPathInside(file, path.resolve(cwd, sub)))
          return { allowed: false, reason: `read-only subpath: ${sub}`, backend, enforcement }
      }
      for (const root of policy.writableRoots) {
        if (isPathInside(file, path.resolve(cwd, root))) return { allowed: true, backend, enforcement }
      }
      if (isPathInside(file, cwd)) return { allowed: true, backend, enforcement }
      return { allowed: false, reason: `outside writable roots: ${file}`, backend, enforcement }
    }
  }
}

export interface ExecRule {
  pattern: string
  allow: boolean
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${esc}$`)
}

export function checkExecPolicy(command: string, rules: ExecRule[]): { allowed: boolean; rule?: ExecRule } {
  for (const rule of rules) {
    if (globToRegExp(rule.pattern).test(command)) return { allowed: rule.allow, rule }
  }
  return { allowed: true }
}

export const DEFAULT_EXEC_RULES: ExecRule[] = [
  { pattern: "rm -rf /*", allow: false },
  { pattern: "rm -rf ~*", allow: false },
  { pattern: "format *", allow: false },
  { pattern: "format", allow: false },
  { pattern: "shutdown *", allow: false },
  { pattern: "shutdown", allow: false },
  { pattern: "reboot*", allow: false },
  { pattern: "poweroff*", allow: false },
  { pattern: "mkfs*", allow: false },
  { pattern: "sudo *", allow: false },
  { pattern: "dd *of=*", allow: false },
  { pattern: "reg delete *", allow: false },
  { pattern: "vssadmin *", allow: false },
  { pattern: "* | sh", allow: false },
  { pattern: "* | sh *", allow: false },
  { pattern: "* | bash", allow: false },
  { pattern: "* | bash *", allow: false },
]

// ─── New OS-Level Enforcement Types ───

export { SandboxType, SandboxEnforcement, SandboxablePreference } from "./types.js"
export {
  NetworkSandboxPolicy,
  FileSystemSandboxPolicy,
  SpawnRequest,
  SpawnedProcess,
  SandboxViolation,
  ManagedProxyConfig,
  WindowsSandboxConfig,
} from "./types.js"
export {
  spawnProcess,
  OUTPUT_MAX_BYTES,
  IO_DRAIN_TIMEOUT_MS,
  DEFAULT_EXEC_COMMAND_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_DELTAS_PER_CALL,
} from "./spawn.js"
export {
  recordFilesystemViolation,
  recordNetworkViolation,
  isFilesystemViolation,
  isNetworkViolation,
  isLikelySandboxDenied,
} from "./violation.js"
export {
  filterEnv,
  detectSandboxType,
  ALLOWED_ENV_VARS,
  BLOCKED_ENV_PATTERNS,
  TemplatePattern,
  evaluateTemplate,
} from "./types.js"
export { ProcessManager, createCancellationToken, combineTokens } from "../../core/src/process.js"
export {
  PolicyManager,
  PolicyParser,
  ExecDecision,
  ExecPolicy,
  ExecPolicyRule,
  NetworkRule,
  ExecPolicyAmendment,
  evaluatePolicy,
} from "../../execpolicy/src/index.js"
export { getSafeEnv, validateEnv, createMinimalEnv } from "../../core/src/env_filter.js"
export { getDatabase, resetDatabase } from "../../core/src/state_db.js"
