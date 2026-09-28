/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { loginWithApiKey, logout, loginStatus } from "../../../../packages/core/src/auth.js"

export async function loginCommand(args: string[]): Promise<string> {
  if (args[0] === "--with-api-key" && args[1]) {
    loginWithApiKey(args[1])
    return "Logged in with API key."
  }
  if (args[0] === "status") {
    const s = loginStatus()
    return `auth: ${s.kind} (file=${s.hasFile} env=${s.hasEnv})`
  }
  return "Usage: trayambak login [--with-api-key <key> | status]"
}

export async function logoutCommand(): Promise<string> {
  return logout() ? "Logged out." : "Not logged in."
}
