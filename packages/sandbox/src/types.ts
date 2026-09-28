/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { existsSync } from "fs"

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
 * - LinuxSeccomp: Linux landlock + seccomp + bubblewrap
 * - WindowsRestrictedToken: Windows restricted token sandbox
 */
export enum SandboxType {
  None = "none",
  MacosSeatbelt = "seatbelt",
  LinuxSeccomp = "seccomp",
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
 * Windows sandbox configuration.
 */
export interface WindowsSandboxConfig {
  level: "none" | "restricted-token" | "elevated"
  workspaceRoots: string[]
  desktop: "public" | "private"
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
   * Filesystem sandbox policy. Carries writable roots and read-only carve-
   * outs for policy consumers; spawnProcess does not yet apply these to the
   * OS sandbox itself (enforcement defaults to policy-only).
   */
  filesystemPolicy: FileSystemSandboxPolicy
  /** Windows-specific configuration. */
  windowsConfig?: WindowsSandboxConfig
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
 * Filter process.env to remove secrets and add sandbox metadata.
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
    // Only include allowed vars
    if (ALLOWED_ENV_VARS.includes(key as any)) {
      filtered[key] = value
    }
  }

  // Add sandbox metadata
  const sandboxType = (permissions as any).__sandboxType ?? "none"
  filtered["CODEX_SANDBOX"] = sandboxType

  const networkPolicy = (permissions as any).__networkPolicy as NetworkSandboxPolicy | undefined
  if (networkPolicy?.disableNetwork) {
    filtered["CODEX_SANDBOX_NETWORK_DISABLED"] = "true"
  }

  return filtered
}

/**
 * Detect the appropriate sandbox type for the current platform and permissions.
 */
export function detectSandboxType(permissions: Record<string, unknown>): SandboxType {
  const mode = (permissions as any).mode as string
  const uiMode = (permissions as any).uiMode as string

  // Yolo/full-access modes get no sandbox (for backward compat)
  if (mode === "yolo" || uiMode === "full-access") {
    return SandboxType.None
  }

  // Read-only/plan modes get filesystem sandbox
  if (uiMode === "read-only" || uiMode === "plan") {
    return SandboxType.None // TODO: Implement once OS sandboxing is wired
  }

  // Default: detect best available
  return detectAvailableSandbox()
}

function detectAvailableSandbox(): SandboxType {
  const platform = process.platform
  try {
    if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      return SandboxType.MacosSeatbelt
    }
    if (platform === "linux" && existsSync("/usr/bin/bwrap")) {
      return SandboxType.LinuxSeccomp
    }
    if (platform === "win32") {
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
