/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Environment variable filtering for sandboxed processes.
 *
 * Ensures no secrets leak into child process environments.
 * BLOCKED_ENV_PATTERNS and filterEnv are defined here rather than
 * imported from sandbox/types to avoid circular dependencies and
 * keep the env filtering logic self-contained.
 */

/** Patterns that match blocked environment variable names. */
export const BLOCKED_ENV_PATTERNS: string[] = [
  "SECRET",
  "KEY",
  "PASSWORD",
  "TOKEN",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "AWS_",
  "GITHUB_",
  "GH_",
]

/**
 * Filter an environment object to remove blocked variables.
 * @param env The environment to filter
 * @param _options Additional options (currently unused)
 * @returns A new env object with blocked variables removed
 */
export function filterEnv(env: Record<string, string>, _options: Record<string, unknown> = {}): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue
    const upper = k.toUpperCase()
    if (BLOCKED_ENV_PATTERNS.some((p) => upper.includes(p))) continue
    result[k] = v
  }
  return result
}

/**
 * Get a safe environment for a sandboxed process.
 * Only includes the essentials needed for command execution.
 */
export function getSafeEnv(
  processEnv: NodeJS.ProcessEnv,
  sandboxType: string = "none",
  networkDisabled: boolean = false,
): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(processEnv)) {
    if (typeof v === "string") clean[k] = v
  }
  const filtered = filterEnv(clean)

  if (networkDisabled) {
    filtered["CODEX_SANDBOX_NETWORK_DISABLED"] = "true"
  }

  filtered["CODEX_SANDBOX"] = sandboxType

  return filtered
}

/**
 * Validate that an environment does not contain blocked variables.
 * Returns list of blocked variable names found.
 */
export function validateEnv(processEnv: NodeJS.ProcessEnv): string[] {
  const blocked: string[] = []
  for (const key of Object.keys(processEnv)) {
    if (BLOCKED_ENV_PATTERNS.some((p: string) => key.toUpperCase().includes(p))) {
      blocked.push(key)
    }
  }
  return blocked
}

/**
 * Create a minimal environment for a sandboxed process.
 * Only includes the essentials needed for command execution.
 */
export function createMinimalEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: process.env.TERM ?? "dumb",
    CODEX_SANDBOX: "policy-only",
  }
}
