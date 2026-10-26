/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { loadConfig, saveConfig, configPath, type NemoConfig } from "../../../runtime/src/index.js"
import { EXIT_USAGE } from "../command-registry.js"
import { isSecretKey, redactSecrets } from "../../../../packages/core/src/secrets.js"
import * as fs from "node:fs"

function displayValue(key: string, value: unknown): string {
  if (isSecretKey(key)) {
    const redacted = redactSecrets({ [key]: value }) as Record<string, unknown>
    return typeof value === "string" && value.length > 0
      ? `${String(redacted[key])} (set, ${value.length} chars)`
      : "(not set)"
  }
  return typeof value === "string" ? value : JSON.stringify(value)
}

export function configCommand(args: string[]): void {
  const sub = args[0]
  if (sub === "path") {
    process.stdout.write(`${configPath()}\n`)
    return
  }
  if (sub === "get") {
    const key = args[1]
    const cfg = loadConfig()
    if (!key) {
      for (const [k, v] of Object.entries(cfg)) {
        process.stdout.write(`${k} = ${displayValue(k, v)}\n`)
      }
      return
    }
    if (!(key in (cfg as unknown as Record<string, unknown>))) {
      process.stderr.write(`Unknown config key "${key}". See 'nemo config get' for known keys.\n`)
      process.exitCode = EXIT_USAGE
      return
    }
    process.stdout.write(`${displayValue(key, (cfg as unknown as Record<string, unknown>)[key] ?? "")}\n`)
    return
  }

  if (sub === "set") {
    const rawKey = args[1]
    const value = args.slice(2).join(" ")
    if (!rawKey || value.length === 0) {
      process.stdout.write("Usage: nemo config set <key> <value>\n")
      return
    }
    // Tolerate flag-style keys ("--apiKey", "--base-url"): persist the
    // canonical camelCase key instead of a stray "--…" entry that
    // loadConfig would ignore (observed: "--apiKey" hid the real key → 401s).
    const key = rawKey.replace(/^--+/, "").replace(/-([a-z])/g, (_, c: string) => (c as string).toUpperCase())
    const coerced = coerce(value)
    saveConfig({ [key]: coerced } as Partial<NemoConfig>)
    // Round-trip proof: sanitizeConfig() rebuilds a typed config and drops
    // unknown keys — without this check "Set bogus = 1" prints success for
    // a key that does nothing (#11/#12).
    if (!(key in (loadConfig() as unknown as Record<string, unknown>))) {
      // Scrub the dead write so config.json doesn't accumulate keys the
      // loader ignores; scrub failure is best-effort, the error is not.
      try {
        const file = configPath()
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
        delete raw[key]
        fs.writeFileSync(file, JSON.stringify(raw, null, 2), "utf8")
      } catch {
        /* best effort */
      }
      process.stderr.write(
        `Unknown config key "${key}" — nothing was stored. See 'nemo config get' for known keys.\n`,
      )
      process.exitCode = EXIT_USAGE
      return
    }
    process.stdout.write(`Set ${key} = ${displayValue(key, coerced)}\n`)
    return
  }

  process.stdout.write("Usage:\n  nemo config path\n  nemo config get [key]\n  nemo config set <key> <value>\n")
}

function coerce(value: string): string | number | boolean {
  if (value === "true") return true
  if (value === "false") return false
  if (/^\d+$/.test(value)) return Number(value)
  return value
}
