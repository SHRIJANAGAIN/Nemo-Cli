/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Feature flags — STABLE_FEATURES plus `FEATURE_<NAME>` env overrides.
 *
 * Stabilization path for large migrations: ship behind a flag defaulting
 * to the stable behavior, flip per-environment via env, delete the old
 * code path once the flag has been default-on for a release.
 */

export const STABLE_FEATURES: Record<string, boolean> = {
  sandboxSpawn: true,
  sqliteState: false,
  vscodeExtension: false,
  streamingGate: true,
  autoTitle: true,
}

function parseEnvFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true
  if (v === "0" || v === "false" || v === "off" || v === "no") return false
  return undefined
}

/** Effective value: `FEATURE_<NAME>` env wins, else the stable default (false for unknown). */
export function isEnabled(name: string): boolean {
  const override = parseEnvFlag(process.env[`FEATURE_${name.toUpperCase()}`])
  if (override !== undefined) return override
  return STABLE_FEATURES[name] ?? false
}

/** All known flags with their effective values. */
export function listFlags(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const name of Object.keys(STABLE_FEATURES)) out[name] = isEnabled(name)
  return out
}
