/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { loadConfig, saveConfig, type TrayambakConfig } from "../../../runtime/src/index.js"

export function configCommand(args: string[]): void {
  const sub = args[0]
  if (sub === "get") {
    const key = args[1]
    const cfg = loadConfig()
    if (!key) {
      for (const [k, v] of Object.entries(cfg)) {
        process.stdout.write(`${k} = ${typeof v === "string" ? v : JSON.stringify(v)}\n`)
      }
      return
    }
    process.stdout.write(`${String((cfg as unknown as Record<string, unknown>)[key] ?? "")}\n`)
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
    process.stdout.write(`Set ${key} = ${typeof coerced === "string" ? coerced : JSON.stringify(coerced)}\n`)
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
