/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Typed environment reads.
 *
 * The `nemo/no-direct-process-env` lint rule tells every module to "route
 * env reads through the sanctioned gateway (packages/core/src/env_filter.ts)",
 * and 132 call sites across the tree were warned for doing exactly what the rule
 * asked — because `env_filter.ts` only FILTERS a child's environment; it had no
 * read API at all. The rule was unsatisfiable.
 *
 * This module is that read surface, and it exists for three concrete reasons,
 * each of which has already cost a real defect:
 *
 *  1. **Truthiness is not parsing.** `if (process.env.NEMO_X)` treats the
 *     empty string as "unset" but the string `"0"` as "on" — so
 *     `NEMO_X=0` enabled whatever it was meant to disable. `envFlag` is the
 *     one place that decides, and it is pinned by tests.
 *  2. **NaN poisons arithmetic.** `Number(process.env.X)` is `NaN` when X is
 *     absent or malformed, and #87/#99/#107 in SECURITY_REVIEW.md are all
 *     "NaN poisoned the budget accumulator". `envNumber` returns `undefined`
 *     instead, so a bad value falls back rather than propagating.
 *  3. **An absent var and an empty var are different.** `envString("X")`
 *     returns `undefined` for absent and `""` for empty, and callers can say
 *     which they meant.
 */

/**
 * Secret-shaped name patterns.
 *
 * DELIBERATELY DUPLICATED rather than imported from env_filter.ts. env_filter
 * imports `BLOCKED_ENV_PATTERNS` from packages/sandbox, so anything in
 * packages/core that reaches env_filter cannot then be imported BY
 * packages/sandbox without closing a cycle — and `windows-ac.ts` (which the
 * env-read migration touches) does exactly that. env_filter's own header notes
 * the constraint: "sandbox/types.ts imports only node:fs, so this import
 * introduces no dependency cycle". Adding a core→sandbox consumer would have
 * broken that invariant, and it did: the sandbox suite failed to load with
 * `SANDBOX_BLOCKED_ENV_PATTERNS` undefined at env_filter.ts:48.
 *
 * The two lists answer different questions anyway:
 *  - env_filter: which names must be STRIPPED from a child's environment.
 *  - this list: whether a name is secret-SHAPED, for redaction and reporting.
 * A child env and a redacted log have different requirements, so they get
 * separate lists and a test pins each.
 */
const SECRET_NAME_PATTERNS = [
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
  "AWS_",
  "GITHUB_",
  "GH_",
]

/** Values that mean "off" in a flag. Anything else non-empty means "on". */
const FALSEY = new Set(["0", "false", "off", "no"])

/** Values that mean "on". Enumerated so a typo is a fallback, not a silent on. */
const TRUTHY = new Set(["1", "true", "on", "yes"])

export type EnvSource = Readonly<Record<string, string | undefined>>

/** The live environment. Injectable everywhere so tests never touch it. */
export function processEnv(): EnvSource {
  return process.env
}

/** Raw string read. `undefined` when unset, `""` when set-but-empty. */
export function envString(name: string, source: EnvSource = processEnv()): string | undefined {
  const value = source[name]
  return value === undefined ? undefined : value
}

/**
 * Read a variable as a flag.
 *
 * Absent, empty, `0`, `false`, `off`, and `no` all mean OFF; `1`, `true`, `on`,
 * and `yes` mean ON. Anything else returns `fallback` rather than guessing, so
 * `NEMO_X=maybe` cannot silently enable a feature.
 */
export function envFlag(name: string, fallback = false, source: EnvSource = processEnv()): boolean {
  const raw = source[name]
  if (raw === undefined) return fallback
  const value = raw.trim().toLowerCase()
  if (value.length === 0) return fallback
  if (FALSEY.has(value)) return false
  if (TRUTHY.has(value)) return true
  return fallback
}

/**
 * Read a variable as a finite number.
 *
 * Returns `undefined` for absent, empty, unparseable, `NaN`, and `Infinity` —
 * never `NaN`. Callers fall back explicitly, which is what #87/#99/#107 needed
 * and did not get.
 */
export function envNumber(
  name: string,
  fallback: number | undefined,
  source: EnvSource = processEnv(),
): number | undefined {
  const raw = source[name]
  if (raw === undefined) return fallback
  const value = raw.trim()
  if (value.length === 0) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return parsed
}

/** Read a variable as an integer, floored toward zero. */
export function envInt(
  name: string,
  fallback: number | undefined,
  source: EnvSource = processEnv(),
): number | undefined {
  const parsed = envNumber(name, fallback, source)
  if (parsed === undefined) return undefined
  return Math.trunc(parsed)
}

/** Read a variable as a bounded number, clamped into [min, max]. */
export function envNumberInRange(
  name: string,
  fallback: number,
  min: number,
  max: number,
  source: EnvSource = processEnv(),
): number {
  const parsed = envNumber(name, fallback, source)
  const value = parsed ?? fallback
  if (min > max) return value
  return Math.min(Math.max(value, min), max)
}

/** Read a variable as a boolean, accepting ONLY an explicit true spelling. */
export function envBooleanStrict(name: string, fallback = false, source: EnvSource = processEnv()): boolean {
  const raw = source[name]
  if (raw === undefined) return fallback
  const value = raw.trim().toLowerCase()
  if (TRUTHY.has(value)) return true
  if (FALSEY.has(value)) return false
  return fallback
}

/** Read a variable as a path list (PATH / PATHEXT), dropping empty entries. */
export function envPathList(name: string, source: EnvSource = processEnv()): string[] {
  const raw = source[name]
  if (raw === undefined || raw.trim().length === 0) return []
  return raw
    .split(process.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Read a variable as a comma-separated list of non-empty entries.
 *
 * Separate from `envPathList`, which splits on the platform PATH separator. That
 * is the wrong separator for every other list-shaped setting — a host list would
 * be split at `host:443`, and on POSIX the colon would also swallow the scheme
 * of any entry that carried one. Comma is unambiguous here because no entry in
 * the lists this serves (hosts, model ids, feature names) can contain one.
 *
 * Blank entries are dropped rather than preserved, because `A,,B` almost always
 * means "A and B" and never means "A, the empty string, and B".
 */
export function envList(name: string, source: EnvSource = processEnv()): string[] {
  const raw = source[name]
  if (raw === undefined || raw.trim().length === 0) return []
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** First variable in `names` that is set to a non-empty value. */
export function envFirst(
  names: readonly string[],
  source: EnvSource = processEnv(),
): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = source[name]
    if (value !== undefined && value.trim().length > 0) return { name, value }
  }
  return undefined
}

/** True when the name is secret-shaped. See SECRET_NAME_PATTERNS for why this
 *  is not env_filter's list. */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return SECRET_NAME_PATTERNS.some((pattern) => upper.includes(pattern))
}

/**
 * Names of the NEMO_ variables present in `source`.
 *
 * Used by `doctor` to show the operator which overrides are actually in effect —
 * the reason this module exists in the first place, made visible.
 */
export function nemoEnvOverrides(source: EnvSource = processEnv()): string[] {
  return Object.keys(source)
    .filter((name) => name.startsWith("NEMO_"))
    .filter((name) => (source[name] ?? "").trim().length > 0)
    .sort()
}

/**
 * Redact every secret-shaped variable in a snapshot, for logging.
 *
 * Values are replaced, not the names, so a log can prove WHICH override was set
 * without disclosing it.
 */
export function redactEnvSnapshot(source: EnvSource = processEnv()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    out[name] = isSecretEnvName(name) ? "[REDACTED]" : value
  }
  return out
}