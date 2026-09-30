/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { loadConfig, saveConfig, type TrayambakConfig } from "../../../runtime/src/index.js"
import { isSecretKey, redactSecrets } from "../../../../packages/core/src/secrets.js"

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
  if (sub === "get") {
    const key = args[1]
    const cfg = loadConfig()
    if (!key) {
      for (const [k, v] of Object.entries(cfg)) {
        process.stdout.write(`${k} = ${displayValue(k, v)}\n`)
      }
      return
    }
    process.stdout.write(`${displayValue(key, (cfg as unknown as Record<string, unknown>)[key] ?? "")}\n`)
    return
  }

  if (sub === "set") {
    const rawKey = args[1]
    const value = args.slice(2).join(" ")
    if (!rawKey || value.length === 0) {
      process.stdout.write("Usage: trayambak config set <key> <value>\n")
      return
    }
    // Tolerate flag-style keys ("--apiKey", "--base-url"): persist the
    // canonical camelCase key instead of a stray "--…" entry that
    // loadConfig would ignore (observed: "--apiKey" hid the real key → 401s).
    const key = rawKey.replace(/^--+/, "").replace(/-([a-z])/g, (_, c: string) => (c as string).toUpperCase())
    const coerced = coerce(value)
    saveConfig({ [key]: coerced } as Partial<TrayambakConfig>)
    process.stdout.write(`Set ${key} = ${displayValue(key, coerced)}\n`)
    return
  }

  process.stdout.write("Usage:\n  trayambak config get [key]\n  trayambak config set <key> <value>\n")
}

function coerce(value: string): string | number | boolean {
  if (value === "true") return true
  if (value === "false") return false
  if (/^\d+$/.test(value)) return Number(value)
  return value
}
