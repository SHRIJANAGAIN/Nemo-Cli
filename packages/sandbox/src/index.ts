/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

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
import { enforcementForBackend } from "./gate.js"
import { windowsAcCapable } from "./windows-ac.js"
import { FORCE_ASK_RULES, globMatch } from "../../protocol/src/permission-rules.js"
import { segmentCommand } from "../../execpolicy/src/segments.js"

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
    // Windows: AppContainer helper present → the real isolator is available.
    // Probe is infrastructure-only; a per-spawn handshake failure still
    // falls back to an unsandboxed spawn inside spawnProcess.
    if (process.platform === "win32" && windowsAcCapable()) return "windows-restricted"
  } catch {
    /* ignore */
  }
  return "fallback"
}

export function enforcementFor(backend: SandboxBackend): EnforcementMode {
  // Single source of truth: gate.enforcementForBackend computes
  // (flag && isolator-capable backend), so this can never disagree with
  // describeEnforcement on the CLI status surface. The flag still
  // defaults off, so the default answer here is unchanged.
  return enforcementForBackend(backend)
}

export interface SandboxCheck {
  allowed: boolean
  reason?: string
  backend: SandboxBackend
  enforcement: EnforcementMode
}

/** realpath with a resolve fallback: missing paths (checked before they
 *  exist, e.g. a write target) still get a lexical answer instead of a throw. */
function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

export function isPathInside(file: string, root: string): boolean {
  // Resolve symlinks/junctions FIRST: a junction pointing at C:\Windows
  // inside a writable root must not pass as "inside" (audit #36). Both
  // sides go through realpath so pre-resolved roots (e.g. macOS /private
  // aliasing under /tmp) compare consistently.
  const rel = path.relative(realpathOrResolve(root), realpathOrResolve(file))
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

/** Compiled-regexp form kept for API compatibility/tests. Enforcement goes
 *  through `globMatch` (linear, ReDoS-proof) — `.*` chains backtracked
 *  catastrophically on long non-matching commands. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${esc}$`)
}

/**
 * Canonical form used for rule matching: trimmed, whitespace runs collapsed,
 * lowercased. This is a * deny list, so folding only ever makes a rule
 * fire more often — `  rm -rf /` and `RM  -RF /` must not slip past an
 * anchored pattern written as `rm -rf /*`.
 */
function canonicalizeForMatch(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

/**
 * Pure rule matcher for display/CLI (`execpolicy check`). Unmatched
 * commands allow — enforcement fail-closed lives in the execpolicy
 * PolicyManager (`evaluate` defaults to Ask) and the protocol permission
 * engine, which are the gates that actually run before execution.
 */
export function checkExecPolicy(command: string, rules: ExecRule[]): { allowed: boolean; rule?: ExecRule } {
  const candidate = canonicalizeForMatch(command)
  for (const rule of rules) {
    // globMatch, not globToRegExp: rules × commands meet here on every
    // execution — a star-heavy pattern must never backtrack-bomb (ReDoS).
    if (globMatch(canonicalizeForMatch(rule.pattern), candidate, { singleChar: true })) {
      return { allowed: rule.allow, rule }
    }
  }
  return { allowed: true }
}

/**
 * Display/CLI variant that evaluates EVERY sub-command, not just the outer
 * string — the same segmentation the enforcement path uses, so `nemo
 * execpolicy check` can never report `allowed` for a command the loop would
 * gate (or vice versa). A single denying segment denies the whole line and
 * the matched rule is reported, so the operator sees WHY it was refused.
 */
export function checkExecPolicyAll(command: string, rules: ExecRule[]): { allowed: boolean; rule?: ExecRule } {
  for (const segment of segmentCommand(command)) {
    const verdict = checkExecPolicy(segment, rules)
    if (!verdict.allowed) return verdict
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
  { pattern: "del */s*", allow: false },
  { pattern: "erase */s*", allow: false },
  { pattern: "rd */s*", allow: false },
  { pattern: "rmdir */s*", allow: false },
  { pattern: "deltree *", allow: false },
  { pattern: "remove-item *-r*", allow: false },
  { pattern: "format-volume*", allow: false },
  { pattern: "stop-computer*", allow: false },
  { pattern: "restart-computer*", allow: false },
  { pattern: "doas *", allow: false },
  { pattern: "runas *", allow: false },
  { pattern: "vssadmin *", allow: false },
  { pattern: "* | sh", allow: false },
  { pattern: "* | sh *", allow: false },
  { pattern: "* | bash", allow: false },
  { pattern: "* | bash *", allow: false },
  // Unified force-ask corpus: everything the approval ladder would gate
  // (protocol FORCE_ASK_RULES — git push --force, del /s /q, Remove-Item,
  // iex/Invoke-Expression, eval(, terraform destroy, …) also reads as deny
  // here, so `execpolicy check` can never disagree with the loop. DERIVED,
  // not duplicated: ladder additions flow in automatically, no second list
  // to maintain. Mapping notes: ladder `ask` renders as display `deny`
  // (this surface is binary; fail-closed for anything the loop would gate),
  // and `*pattern*` wrapping reproduces the ladder's unanchored substring
  // semantics exactly under this file's anchored matcher (verified: the
  // corpus contains no `*?[]{}`, so no glob-compiler divergence).
  ...FORCE_ASK_RULES.filter((r) => r.action === "ask").map((r) => ({
    pattern: `*${r.pattern}*`,
    allow: false,
  })),
]

// ─── New OS-Level Enforcement Types ───

export { SandboxType, SandboxEnforcement, SandboxablePreference } from "./types.js"
export { describeEnforcement, enforcementForBackend, osCapableBackend, shouldUseOsSandbox } from "./gate.js"
export {
  NetworkSandboxPolicy,
  FileSystemSandboxPolicy,
  SpawnRequest,
  SpawnedProcess,
  SandboxViolation,
  ManagedProxyConfig,
} from "./types.js"
export {
  spawnProcess,
  OUTPUT_MAX_BYTES,
  IO_DRAIN_TIMEOUT_MS,
  DEFAULT_EXEC_COMMAND_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_DELTAS_PER_CALL,
} from "./spawn.js"
export {
  WINDOWS_AC_PROFILE_NAME,
  WINDOWS_AC_SHIM_SCRIPT,
  quoteWindowsArg,
  quoteWindowsArgv,
  acCapabilitySids,
  windowsAcCapable,
  setWindowsAcProbeForTests,
  spawnWindowsAcShim,
  taskkillTree,
} from "./windows-ac.js"
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

/* Host policy. `allowedDomains`/`blockedDomains` were declared on
 * NetworkSandboxPolicy and consulted by nothing; `isNetworkTool`, which
 * AGENTS.md names as the mechanism requiring approval outside danger mode, did
 * not exist at all. Both now live behind one entry point so a caller cannot end
 * up with a second, subtly different matcher. */
export {
  HOST_POLICY_ENV,
  domainMatches,
  hostPolicyFromEnv,
  hostPolicyFromPermissionsWithEnv,
  extractHosts,
  hostPolicyFromPermissions,
  isNetworkTool,
  networkToolNames,
  networkViolationForCommand,
  normalizeDomain,
  type HostPolicy,
} from "./network-policy.js"

/* Socket-level policy: the authoritative per-connection decision.
 *
 * `networkViolationForCommand` above decides from the command TEXT. That catches
 * `curl https://blocked.example` before a process exists and cannot be walked
 * past by a destination assembled at runtime, an interpreter that opens a socket
 * without naming one, or — the hole this closes — an IP literal, which matches no
 * domain entry and was therefore reachable under a deny-list. `decideRoute` is
 * total, has no I/O, and refuses address literals whatever the lists say, so the
 * layer that enforces it can be swapped without the policy drifting from what was
 * reviewed. */
export {
  addressVerdictReason,
  classifyHost,
  decideRoute,
  isRefusedAddress,
  proxyEndpoint,
  routeTableFor,
  tableIsEnforcing,
  type AddressVerdict,
  type EndpointProblem,
  type ProxyEndpoint,
  type RouteDecision,
  type RoutePolicy,
  type RouteRule,
  type RouteTable,
} from "./proxy-routing.js"
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
