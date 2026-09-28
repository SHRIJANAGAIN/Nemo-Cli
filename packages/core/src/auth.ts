/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/** AuthManager: login/logout/status with ApiKey + env fallback (Codex login parity, minimal). */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export type AuthKind = "api-key" | "env" | "none"

export function credentialsPath(): string {
  if (process.env.TRAYAMBAK_CREDENTIALS_FILE) return process.env.TRAYAMBAK_CREDENTIALS_FILE
  return path.join(os.homedir(), ".trayambak", "credentials.json")
}

export function loginWithApiKey(key: string): void {
  const file = credentialsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ apiKey: key.trim(), updatedAt: Date.now() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    /* non-POSIX */
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort */
  }
}

export function logout(): boolean {
  const file = credentialsPath()
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  return true
}

export function loginStatus(): { kind: AuthKind; hasFile: boolean; hasEnv: boolean } {
  const hasFile = fs.existsSync(credentialsPath())
  const hasEnv = Boolean(process.env.TRAYAMBAK_API_KEY)
  return { kind: hasFile ? "api-key" : hasEnv ? "env" : "none", hasFile, hasEnv }
}
