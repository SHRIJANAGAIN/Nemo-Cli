/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */
import { existsSync } from "fs"

import { isEnabled } from "../../core/src/feature_flags.js"
import { windowsAcCapable } from "./windows-ac.js"

/**
 * Enhanced sandbox types — OS-level enforcement model.
 *
 * This module defines the type system for sandbox enforcement that goes
 * beyond in-process policy evaluation. It mirrors Codex's SandboxType
 * and SandboxEnforcement enums, providing the foundation for OS-level
 * sandbox spawning in the runtime.
 */

/**
 * Sandbox type determines HOW the process is isolated at the OS level.
 *
 * - None: No sandbox (fallback for unsupported platforms)
 * - MacosSeatbelt: macOS sandbox-exec with .sbpl policy files
 * - LinuxSeccomp: Linux namespaces + seccomp filter + bubblewrap
 * - LinuxNamespace: Linux namespaces + bubblewrap, NO seccomp filter
 * - WindowsRestrictedToken: Windows restricted token sandbox
 *
 * `LinuxNamespace` exists because `LinuxSeccomp` was reported unconditionally
 * while no seccomp filter was ever installed. A handle naming a layer it does not
 * have is worse than one naming the layer it does have: the caller cannot warn
 * about a protection it believes is present. It is set only when the filter could
 * not be staged, and `fallbackReason` says so on the same handle.
 */
export enum SandboxType {
  None = "none",
  MacosSeatbelt = "seatbelt",
  LinuxSeccomp = "seccomp",
  LinuxNamespace = "linux_namespace",
  WindowsRestrictedToken = "windows_sandbox",
}

/**
 * Enforcement mode indicates whether the sandbox is actually enforced
 * at the OS kernel level or only evaluated in-process.
 *
 * - PolicyOnly: In-process policy evaluation only (current state)
 * - OsSandbox: OS-level enforcement (target state)
 */
export enum SandboxEnforcement {
  PolicyOnly = "policy-only",
  OsSandbox = "os-sandbox",
}

/**
 * Platform sandbox preference.
 */
export enum SandboxablePreference {
  Auto = "auto",
  Require = "require",
  Forbid = "forbid",
}

/**
 * Network sandbox policy — controls what network access the sandbox allows.
 */
export interface NetworkSandboxPolicy {
  /** If true, all network access is blocked inside the sandbox. */
  disableNetwork: boolean
  /** Allowed domains (empty = all allowed, unless disableNetwork is true). */
  allowedDomains: string[]
  /** Blocked domains. Takes precedence over allowedDomains. */
  blockedDomains: string[]
  /** Managed proxy configuration for traffic inspection. */
  proxy?: ManagedProxyConfig
}

export interface ManagedProxyConfig {
  url: string
  caBundlePath?: string
}

/**
 * Filesystem sandbox policy — controls filesystem access inside the sandbox.
 */
export interface FileSystemSandboxPolicy {
  /** Root directories the sandbox can access. */
  writableRoots: string[]
  /** Subdirectories within writableRoots that remain read-only. */
  readOnlySubpaths: string[]
  /** Deny-read paths (files/dirs that cannot be read even from writable roots). */
  denyReadPaths: string[]
  /** Deny-write paths. */
  denyWritePaths: string[]
}

/**
 * Complete sandbox request for spawning a process.
 */
export interface SpawnRequest {
  /** The command to execute. */
  command: string[]
  /** Working directory. */
  cwd: string
  /** Which sandbox type to use. */
  sandboxType: SandboxType
  /** Filtered environment variables. */
  env: Record<string, string>
  /** Network sandbox policy. */
  networkPolicy: NetworkSandboxPolicy
  /**
   * Filesystem sandbox policy. Carries writable roots and read-only carve-outs.
   *
   * Applied to the OS sandbox: `seatbeltProfile` and `landlockArgs` both read it.
   * It used to be threaded this far and read by neither backend, which is why
   * both reported `isSandboxed: true` over a writable workspace during a
   * read-only session.
   */
  filesystemPolicy: FileSystemSandboxPolicy
  /**
   * Linux only. False to spawn without the seccomp filter.
   *
   * Defaults to true: an absent field must not mean "off", because every
   * existing caller was written before the filter existed and would otherwise
   * silently keep the thinner sandbox. Callers that want it off have to say so.
   */
  seccomp?: boolean
  /** Output byte cap — the default ceiling for SpawnedProcess.readAll. */
  outputCap: number
  /** Timeout in milliseconds. Enforced by spawnProcess (<= 0 disables). */
  timeoutMs: number
  /** Abort signal. */
  signal?: AbortSignal
}

/**
 * Result of spawning a sandboxed process.
 */
export interface SpawnedProcess {
  /** The child process handle. */
  pid: number
  /** Whether the process is running inside an OS-level sandbox. */
  isSandboxed: boolean
  /** The sandbox type actually applied. */
  sandboxType: SandboxType
  /**
   * Why OS isolation was not applied, when the spawner knows. Set on the
   * honest fallback paths (workload incompatible with the container,
   * handshake failure) so tool output can say *why* it is policy-only
   * instead of silently dropping the marker.
   */
  fallbackReason?: string
  /** Process group ID for tree-killing. */
  processGroupId: number
  /** Kill the entire process tree. */
  kill: (signal?: string) => Promise<void>
  /** Read all output with capping. */
  readAll: (options?: { maxBytes?: number; maxDeltas?: number }) => Promise<string>
  /** Wait for process to exit. */
  waitForExit: () => Promise<number>
}

/**
 * Sandbox violation record.
 */
export interface SandboxViolation {
  type: "filesystem" | "network"
  path?: string
  domain?: string
  operation: string
  timestamp: number
  pid: number
}

/**
 * Environment variable filter configuration.
 */
export const ALLOWED_ENV_VARS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "SYSTEMROOT",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "COMPUTERNAME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramW6432",
  "windir",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "LOGONDOMAIN",
  "LOGONID",
  "USERDOMAIN",
  "USERNAME",
  "USERDOMAIN_ROAMINGPROFILE",
] as const

/**
 * Environment variables that are ALWAYS BLOCKED in sandbox.
 */
export const BLOCKED_ENV_PATTERNS = [
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "CREDENTIAL",
  "AWS_",
  "GH_",
  "GITHUB_",
  "NVAPI_",
  "OPENAI",
  "ANTHROPIC",
  "GOOGLE",
  "XAI_",
  "HUGGING",
  "OLLAMA",
  "LMS",
  "PRIVATE_KEY",
  "SSL_",
  "SSH_",
  "JWT",
  "COOKIE",
  "AUTH_",
  "BEARER",
  "ACCESS_KEY",
  "SESSION_",
] as const

/**
 * ALLOWED_ENV_VARS upper-cased once. The membership test below must be
 * case-INsensitive: Windows environment blocks spell names `Path` and
 * `SystemRoot` while the allowlist writes `PATH`/`SYSTEMROOT`, and a
 * case-sensitive `includes()` silently dropped PATH from every child
 * process spawned there (on Windows the OS treats `Path` and `PATH` as
 * the same variable, so folding case loses nothing).
 */
const ALLOWED_ENV_VARS_UPPER: ReadonlySet<string> = new Set(ALLOWED_ENV_VARS.map((name) => name.toUpperCase()))

/**
 * Filter process.env to remove secrets and add sandbox metadata.
 *
 * Deny patterns first (a blocked name never survives, even if it is also
 * allowlisted), then an allowlist: anything not named in
 * ALLOWED_ENV_VARS is dropped, so unknown credential-shaped variables
 * never reach a sandboxed child by default.
 */
export function filterEnv(
  processEnv: Record<string, string>,
  permissions: Record<string, unknown>,
): Record<string, string> {
  const filtered: Record<string, string> = {}

  for (const [key, value] of Object.entries(processEnv)) {
    // Skip blocked patterns
    if (BLOCKED_ENV_PATTERNS.some((p) => key.toUpperCase().includes(p))) {
      continue
    }
    // Only include allowed vars (case-insensitively, see the set above)
    if (ALLOWED_ENV_VARS_UPPER.has(key.toUpperCase())) {
      filtered[key] = value
    }
  }

  // Add sandbox metadata
  const sandboxType = (permissions.__sandboxType as string | undefined) ?? "none"
  filtered["NEMO_SANDBOX"] = sandboxType

  const networkPolicy = permissions.__networkPolicy as NetworkSandboxPolicy | undefined
  if (networkPolicy?.disableNetwork) {
    filtered["NEMO_SANDBOX_NETWORK_DISABLED"] = "true"
  }

  return filtered
}

/**
 * Detect the appropriate sandbox type for the current platform and permissions.
 *
 * Every mode engages the OS isolator when the platform has one. The two
 * short-circuits that used to report `SandboxType.None` are gone:
 *
 *  - **`yolo` / `full-access` no longer disables the sandbox.** "Full access"
 *    meant "stop asking me", never "turn the kernel off". The escape hatch
 *    for a genuinely unrestricted shell is `FEATURE_SANDBOXSPAWN=0`, which is
 *    explicit, documented, and reviewable — unlike a config alias that
 *    silently removed OS containment.
 *  - **`read-only` / `plan` no longer report `None`.** This was the
 *    unimplemented placeholder that promised a filesystem sandbox and
 *    delivered `None`, and it was backwards: the two modes that promise the
 *    MOST restriction were the only two carrying NO OS containment, so a
 *    "safe" session ran with nothing behind it but the in-process screen.
 *
 * The mode still matters — it now selects the *filesystem* policy
 * (`osSpawnRequest({ readOnly: true })` in the bash tool) instead of switching
 * the isolator off. That is the correct shape: the isolator is a property of
 * the platform, the restriction is a property of the mode.
 *
 * The feature flag is consulted HERE and not only in `shouldUseOsSandbox`,
 * because `getSafeEnv` stamps this value verbatim into the child environment
 * as `NEMO_SANDBOX`. A capability detected while the flag is off would put an
 * unapplied "sandboxed" claim on every spawn, which is the exact
 * marker-claims-enforcement-that-never-applied failure the repo's honest-
 * descriptor rules exist to prevent.
 *
 * The permissions bag is retained on the signature because every caller
 * already builds it (`bash.ts` derives it from the tool context); the mode it
 * carries is consumed by the filesystem policy, not by this decision.
 */
export function detectSandboxType(_permissions: Record<string, unknown>): SandboxType {
  if (!isEnabled("sandboxSpawn")) return SandboxType.None
  return detectAvailableSandbox()
}

function detectAvailableSandbox(): SandboxType {
  const platform = process.platform
  try {
    if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      return SandboxType.MacosSeatbelt
    }
    if (platform === "linux" && existsSync("/usr/bin/bwrap")) {
      // This probe answers CAPABILITY, not what gets applied. bwrap being present
      // says nothing about whether the seccomp filter can be staged, so the
      // applied truth comes from the spawn handle, which reports `LinuxNamespace`
      // when the filter is missing. Overstating it here would put the optimistic
      // value back on the same handle this path just fixed.
      return SandboxType.LinuxSeccomp
    }
    // Windows: AppContainer via the PowerShell shim (windows-ac.ts). The
    // probe answers infrastructure-only — if the helper cannot run,
    // spawnUnderWindowsAppContainer falls back to an honest unsandboxed
    // spawn, and returning None here keeps the NEMO_SANDBOX stamp truthful
    // before anything has even spawned.
    if (platform === "win32" && windowsAcCapable()) {
      return SandboxType.WindowsRestrictedToken
    }
  } catch {
    /* ignore */
  }
  return SandboxType.None
}

/**
 * Check if a command should be allowed through the template enforcement engine.
 */
export interface TemplatePattern {
  name: string
  pattern: RegExp
  allowedArgs: string[]
  description: string
}

export function evaluateTemplate(
  command: string,
  templates: TemplatePattern[],
): { allowed: boolean; template?: TemplatePattern; reason?: string } {
  for (const template of templates) {
    if (template.pattern.test(command)) {
      return { allowed: true, template }
    }
  }
  return { allowed: false, reason: "Command does not match any approved template" }
}
