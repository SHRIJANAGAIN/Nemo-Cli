/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * GitHub user-authorization store — the CLI↔VPS↔GitHub loop's memory.
 *
 * The CLI (which holds no GitHub credentials) asks for a login URL bound
 * to its machine id; the user approves in a browser; GitHub redirects to
 * our callback with a code; we swap it for a user token and file it under
 * the machine id. Later `/github/read` calls present the machine id and
 * ride that token. Pending states die after 10 minutes; tokens live until
 * logout (or GitHub-side revoke). One JSON file, 0600, atomic tmp+rename —
 * same discipline as the license registry, sized for the same traffic.
 */

import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface OAuthState {
  state: string
  machineId: string
  createdAt: number
}

export interface OAuthToken {
  machineId: string
  /** GitHub user access token. NEVER logged, never returned to the CLI. */
  token: string
  login: string
  createdAt: number
}

interface OAuthFile {
  version: 1
  states: Record<string, OAuthState>
  tokens: Record<string, OAuthToken>
}

export function defaultOAuthPath(): string {
  return process.env.GITHUB_OAUTH_PATH ?? "./data/github-oauth.json"
}

/** Pending states live 10 minutes — enough to open a browser, approve, and
 *  come back; short enough that a leaked `state` rots fast. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Non-POSIX (win32 ACLs) — best effort.
  }
  renameSync(tmp, file)
}

function loadFile(file: string): OAuthFile {
  const empty: OAuthFile = { version: 1, states: {}, tokens: {} }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<OAuthFile>
    if (!parsed || typeof parsed !== "object") return empty
    return {
      version: 1,
      states: parsed.states && typeof parsed.states === "object" ? parsed.states : {},
      tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {},
    }
  } catch {
    // Torn write — availability wins; every mutation rewrites fresh.
    return empty
  }
}

export class GitHubOAuthStore {
  private states: Record<string, OAuthState>
  private tokens: Record<string, OAuthToken>
  private readonly file: string

  constructor(file?: string) {
    this.file = file ?? defaultOAuthPath()
    const loaded = loadFile(this.file)
    this.states = loaded.states
    this.tokens = loaded.tokens
    this.pruneStates()
  }

  private save(): void {
    atomicWriteJson(this.file, { version: 1, states: this.states, tokens: this.tokens } satisfies OAuthFile)
  }

  private pruneStates(now = Date.now()): void {
    let dirty = false
    for (const [k, s] of Object.entries(this.states)) {
      if (!s || now - s.createdAt > OAUTH_STATE_TTL_MS) {
        delete this.states[k]
        dirty = true
      }
    }
    if (dirty) this.save()
  }

  /** Begin a login: fresh state bound to the machine. Replaces any pending
   *  state for the same machine (only the newest browser tab can win). */
  beginLogin(machineId: string): OAuthState {
    this.pruneStates()
    for (const [k, s] of Object.entries(this.states)) {
      if (s.machineId === machineId) delete this.states[k]
    }
    const state: OAuthState = { state: randomUUID().replace(/-/g, ""), machineId, createdAt: Date.now() }
    this.states[state.state] = state
    this.save()
    return state
  }

  /** Consume a state at callback time (single-use: replaying the redirect
   *  URL authorizes nothing twice). Returns the machine, or null. */
  consumeState(state: string): string | null {
    this.pruneStates()
    const s = this.states[state]
    if (!s) return null
    delete this.states[state]
    this.save()
    return s.machineId
  }

  storeToken(machineId: string, token: string, login: string): void {
    this.tokens[machineId] = { machineId, token, login, createdAt: Date.now() }
    this.save()
  }

  tokenFor(machineId: string): OAuthToken | undefined {
    return this.tokens[machineId]
  }

  logout(machineId: string): boolean {
    if (!this.tokens[machineId]) return false
    delete this.tokens[machineId]
    this.save()
    return true
  }

  get size(): number {
    return Object.keys(this.tokens).length
  }
}
