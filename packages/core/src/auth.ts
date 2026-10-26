/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** AuthManager: login/logout/status with ApiKey + env fallback (Codex login parity, minimal). */

import * as os from "os"
import * as path from "path"

import { envString } from "./env_read.js"
import {
  bestCredentialStore,
  fileStore,
  keychainStore,
  keychainAvailable,
  redactSecret,
  type CredentialStore,
} from "./credential_store.js"

export type AuthKind = "api-key" | "env" | "none"

export function credentialsPath(): string {
  // Routed through the sanctioned env gateway rather than read inline: the repo's
  // own `no-direct-process-env` rule exists so every env read can be audited in
  // one place, and auth.ts was bypassing it.
  const override = envString("NEMO_CREDENTIALS_FILE")
  if (override !== undefined && override.trim().length > 0) return override
  return path.join(os.homedir(), ".nemo", "credentials.json")
}

/**
 * Build the store for the live environment.
 *
 * `NEMO_CREDENTIAL_PREFER_FILE=1` forces the hardened file store on every
 * platform, including macOS and Linux. That escape hatch exists because the
 * macOS keychain write passes the secret in argv (see `credential_store.ts`),
 * and a caller who cannot accept that wants the file.
 *
 * Rebuilt per call rather than cached at module load: a test that changes the
 * environment would otherwise be served a store built from the previous one, so
 * the suite would depend on test ordering.
 *
 * Named `resolveStore` rather than `store` because a parameter named `store`
 * shadows it, and the default-argument form then silently stops being callable.
 */
function resolveStore(): CredentialStore {
  const preferFile = envString("NEMO_CREDENTIAL_PREFER_FILE") === "1"
  const file = credentialsPath()
  return bestCredentialStore({ file, service: "nemo", account: "credentials", preferFile })
}

/** Prefer the keychain when one exists; fall back to the hardened file store. */
export function defaultCredentialStore(): CredentialStore {
  const file = credentialsPath()
  if (!keychainAvailable()) return fileStore({ file })
  return keychainStore({ service: "nemo", account: "credentials" })
}

/**
 * The store the auth helpers use.
 *
 * Takes an override so a test can substitute a store without touching process
 * environment, which is the ambient dependency the repo's config-test rule
 * forbids.
 */
export function credentialStore(override?: CredentialStore): CredentialStore {
  return override ?? resolveStore()
}

export function loginWithApiKey(key: string, override?: CredentialStore): void {
  credentialStore(override).write(key.trim())
}

export function logout(override?: CredentialStore): boolean {
  // Clear WITHOUT deleting: removing the file creates a path-existence
  // oracle (logged-in vs never-logged-in distinguishable by stat).
  return credentialStore(override).clear()
}

function storedApiKey(override?: CredentialStore): string {
  try {
    return credentialStore(override).read() ?? ""
  } catch (error) {
    // A store failure must not surface the payload it was carrying.
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(redactSecret(message))
  }
}

export function loginStatus(override?: CredentialStore): {
  kind: AuthKind
  hasFile: boolean
  hasEnv: boolean
} {
  const hasFile = storedApiKey(override).length > 0
  const hasEnv = Boolean(envString("NEMO_API_KEY"))
  return { kind: hasFile ? "api-key" : hasEnv ? "env" : "none", hasFile, hasEnv }
}