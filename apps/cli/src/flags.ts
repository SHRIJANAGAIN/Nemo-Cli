/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Flag parser.
 *
 * Lenient by default (historical callers keep working); strict when the
 * dispatcher passes the command's accepted flag set from the command
 * registry — unknown flags and missing values then become usage errors
 * (exit code 2) instead of silently turning into bogus "true" values.
 */

export interface ParseOptions {
  /** Every accepted flag name AND alias (see knownFlagNames in command-registry). */
  known?: ReadonlySet<string>
  /** canonical-or-alias → "string" | "boolean" (see flagTypeMap in command-registry). */
  types?: ReadonlyMap<string, "string" | "boolean">
  /** alias → canonical name, so `--m x` populates flags.model (see flagAliasMap). */
  aliasMap?: ReadonlyMap<string, string>
  /** Report unknown flags / missing values in `unknown` + `errors`. */
  strict?: boolean
}

export interface ParseResult {
  flags: Record<string, string>
  positional: string[]
  /** Unknown flag names, in order (strict mode). */
  unknown: string[]
  /** Usage problems, human-readable (strict mode). */
  errors: string[]
}

const SINGLE_DASH_WITH_VALUE = new Set(["-p", "-m", "-c"])
const SINGLE_DASH_BOOL: Record<string, string> = { "-h": "help", "-v": "version" }

export function parseFlags(argv: string[], options?: ParseOptions): ParseResult {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  const unknown: string[] = []
  const errors: string[] = []
  const strict = options?.strict ?? false
  const known = options?.known
  const types = options?.types
  const aliasMap = options?.aliasMap

  const isKnown = (name: string): boolean => !known || known.has(name)
  const typeOf = (name: string): "string" | "boolean" | undefined => types?.get(name)
  const canonical = (name: string): string => aliasMap?.get(name) ?? name

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue

    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      if (eq > 2) {
        const name = arg.slice(2, eq)
        if (strict && !isKnown(name)) {
          unknown.push(`--${name}`)
          errors.push(`unknown flag: --${name}`)
        }
        flags[canonical(name)] = arg.slice(eq + 1)
        continue
      }
      const key = arg.slice(2)
      if (key.startsWith("no-") && key.length > 3) {
        const positive = key.slice(3)
        if (strict && !isKnown(positive)) {
          unknown.push(`--${key}`)
          errors.push(`unknown flag: --${key}`)
        }
        flags[canonical(positive)] = "false"
        continue
      }
      if (strict && !isKnown(key)) {
        unknown.push(`--${key}`)
        errors.push(`unknown flag: --${key}`)
        // fall through with lenient parsing so downstream still sees a value
      }
      const out = canonical(key)
      const type = typeOf(key)
      if (type === "boolean") {
        flags[out] = "true"
        continue
      }
      const next = argv[i + 1]
      if (type === "string") {
        if (next === undefined || next.startsWith("-")) {
          if (strict) errors.push(`flag --${key} requires a value`)
          flags[out] = ""
        } else {
          flags[out] = next
          i++
        }
        continue
      }
      // Unknown/legacy behavior: consume the next non-flag token as value.
      if (next !== undefined && !next.startsWith("-")) {
        flags[out] = next
        i++
      } else {
        flags[out] = "true"
      }
    } else if (SINGLE_DASH_WITH_VALUE.has(arg)) {
      const key = arg === "-p" ? "prompt" : arg === "-m" ? "model" : "cwd"
      const next = argv[i + 1]
      if (next && !next.startsWith("-")) {
        flags[key] = next
        i++
      } else {
        flags[key] = ""
        if (strict && key !== "cwd") errors.push(`flag ${arg} requires a value`)
      }
    } else if (SINGLE_DASH_BOOL[arg]) {
      flags[SINGLE_DASH_BOOL[arg]] = "true"
    } else {
      positional.push(arg)
    }
  }

  return { flags, positional, unknown, errors }
}

/**
 * Validate a port flag value: returns the integer port (1-65535) or
 * null when the value is not a valid TCP port — callers should treat
 * null as a usage error (exit code 2).
 */
export function portValue(value: string | undefined): number | null {
  if (value === undefined || value === "") return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null
  return n
}
