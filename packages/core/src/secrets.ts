/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

/** Cross-process best-effort file lock (mkdir-based, portable). */
export async function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const lockDir = `${file}.lock`
  const deadline = Date.now() + 5000
  while (true) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch {
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try {
    return await fn()
  } finally {
    try {
      fs.rmdirSync(lockDir)
    } catch {
      /* best effort */
    }
  }
}

const SECRET_KEYS = ["apiKey", "api_key", "apikey", "token", "secret", "authorization"]

/** Deep-redact secrets for logs/diagnostics. Never prints key material. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^(nvapi-|sk-|hf_|xai-|AIza)/.test(value.trim()) || value.length > 24) {
      return value.slice(0, 4) + "****"
    }
    return value
  }
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.some((s) => k.toLowerCase().includes(s)) ? "****" : redactSecrets(v)
    }
    return out
  }
  return value
}

export function secureDir(dir?: string): string {
  const d = dir ?? path.join(os.homedir(), ".trayambak")
  fs.mkdirSync(d, { recursive: true })
  try {
    fs.chmodSync(d, 0o700)
  } catch {
    /* Windows */
  }
  return d
}
