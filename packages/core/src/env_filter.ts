/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

import { BLOCKED_ENV_PATTERNS as SANDBOX_BLOCKED_ENV_PATTERNS } from "../../sandbox/src/types.js"

/**
 * Environment variable filtering for sandboxed processes.
 *
 * Ensures no secrets leak into child process environments. The block list
 * is the UNION of the local entries below and the canonical provider-key
 * list in packages/sandbox (single source of truth for model-provider
 * families: OPENAI, ANTHROPIC, NVAPI_, XAI_, …). sandbox/types.ts imports
 * only node:fs, so this import introduces no dependency cycle — and the
 * deny-list semantics stay here because shells need their full environment
 * to build and test (the sandbox allowlist would strip JAVA_HOME,
 * NODE_OPTIONS, npm config, … and break real builds).
 */

/** Local deny entries: secret-shaped names plus families the sandbox list
 *  does not cover (DSN/WEBHOOK/DATABASE_URL/DOCKER/KUBE, bare KEY/SESSION/
 *  AUTH which are broader than the sandbox's suffixed variants). */
const LOCAL_BLOCKED_ENV_PATTERNS: string[] = [
  "SECRET",
  "KEY",
  "PASSWORD",
  "TOKEN",
  "CREDENTIAL",
  "PRIVATE_KEY",
  "BEARER",
  "JWT",
  "COOKIE",
  "SESSION",
  "AUTH",
  "DSN",
  "WEBHOOK",
  "DATABASE_URL",
  "DOCKER",
  "KUBE",
  "AWS_",
  "GITHUB_",
  "GH_",
]

/** Patterns that match blocked environment variable names. Deny-list: anything
 *  not matching passes through (shells need their full environment to build
 *  and test), so secret-bearing families must be enumerated here. */
export const BLOCKED_ENV_PATTERNS: string[] = [
  ...LOCAL_BLOCKED_ENV_PATTERNS,
  ...SANDBOX_BLOCKED_ENV_PATTERNS.filter((p) => !LOCAL_BLOCKED_ENV_PATTERNS.includes(p)),
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
