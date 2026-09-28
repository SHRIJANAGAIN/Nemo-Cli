/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Environment variable filtering for sandboxed processes.
 *
 * Ensures no secrets leak into child process environments.
 */

import { BLOCKED_ENV_PATTERNS, filterEnv } from "../../sandbox/src/types.js"

/**
 * Filter function that can be used by bash tool and other exec functions.
 *
 * @param processEnv The original process.env
 * @param sandboxType The active sandbox type
 * @param networkDisabled Whether network is disabled in sandbox
 * @returns Filtered environment safe for child process
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
  const filtered = filterEnv(clean, { __sandboxType: sandboxType })

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
