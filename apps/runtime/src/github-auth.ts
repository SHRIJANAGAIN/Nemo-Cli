/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * GitHub user-authorization client (CLI side of the OAuth loop).
 *
 * Flow: `startGithubLogin` asks the license server for an authorize URL +
 * state (bound to this machine's id) → the user opens it in a browser and
 * approves the GitHub App → GitHub redirects to the server callback, which
 * swaps the code for a user token and files it under the machine id →
 * `pollGithubLogin` sees `authorized: true`. Afterwards `readGithubIssue`
 * fetches through the server with that token — the CLI never holds GitHub
 * credentials itself, and revoking happens server-side (/auth/github/logout
 * or GitHub settings). All fns are total: transport failure is a value,
 * never a throw (except getMachineId's own file errors, surfaced as
 * reasons like the license client does).
 */

import { DEFAULT_LICENSE_SERVER, getMachineId } from "./license.js"
import { spawn } from "node:child_process"

/** Open the system browser at `url`. Returns false when suppressed
 *  (TRAYAMBAK_NO_BROWSER=1, headless) or the launch fails — callers then
 *  fall back to printing the URL for manual copy-paste. */
export function openBrowser(url: string): boolean {
  if (process.env.TRAYAMBAK_NO_BROWSER === "1") return false
  try {
    if (process.platform === "win32") {
      // rundll32 avoids cmd.exe's `&`/quote parsing entirely (OAuth URLs
      // carry query strings).
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref()
      return true
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open"
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref()
    return true
  } catch {
    return false
  }
}

export interface GithubAuthOptions {
  serverUrl?: string
  machineId?: string
  timeoutMs?: number
}

function authServerBase(serverUrl?: string): string {
  const raw = (serverUrl ?? process.env.TRAYAMBAK_LICENSE_SERVER ?? DEFAULT_LICENSE_SERVER).trim()
  return (raw || DEFAULT_LICENSE_SERVER).replace(/\/+$/, "")
}

async function postAuth(
  path: string,
  body: Record<string, unknown>,
  serverUrl: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${authServerBase(serverUrl)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // Non-JSON error page (proxy/Cloudflare) — status carries the signal.
  }
  return { status: res.status, json }
}

async function getAuth(
  path: string,
  serverUrl: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${authServerBase(serverUrl)}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json: Record<string, unknown> = {}
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    // Same non-JSON tolerance as POST.
  }
  return { status: res.status, json }
}

function machine(opts: GithubAuthOptions): string {
  return opts.machineId ?? getMachineId()
}

/** Begin login: returns the browser URL + state. The user opens the URL,
 *  approves, and `pollGithubLogin` watches for completion. */
export async function startGithubLogin(
  opts: GithubAuthOptions = {},
): Promise<{ ok: boolean; url?: string; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch (err) {
    return { ok: false, reason: `cannot read machine identity (${err instanceof Error ? err.message : String(err)})` }
  }
  try {
    const { status, json } = await postAuth(
      "/auth/github/start",
      { machineId },
      opts.serverUrl,
      opts.timeoutMs ?? 10_000,
    )
    if (status !== 200 || json.ok !== true || typeof json.url !== "string") {
      const reason =
        typeof json.reason === "string" ? json.reason : typeof json.error === "string" ? json.error : `HTTP ${status}`
      return { ok: false, reason }
    }
    return { ok: true, url: json.url }
  } catch (err) {
    const detail = err instanceof Error ? err.name : String(err)
    return { ok: false, reason: `license server unreachable (${detail}) — connect and retry` }
  }
}

export interface GithubLoginStatus {
  authorized: boolean
  login?: string
}

/** One status peek (no waiting). */
export async function githubLoginStatus(
  opts: GithubAuthOptions = {},
): Promise<GithubLoginStatus & { reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { authorized: false, reason: "cannot read machine identity" }
  }
  try {
    const { status, json } = await getAuth(
      `/auth/github/status?machineId=${encodeURIComponent(machineId)}`,
      opts.serverUrl,
      opts.timeoutMs ?? 10_000,
    )
    if (status !== 200) return { authorized: false }
    return {
      authorized: json.authorized === true,
      login: typeof json.login === "string" ? json.login : undefined,
    }
  } catch {
    return { authorized: false, reason: "license server unreachable" }
  }
}

/** Wait (politely: 2s cadence) for the browser approval, up to ~60s. */
export async function pollGithubLogin(
  opts: GithubAuthOptions & { tries?: number; intervalMs?: number } = {},
): Promise<GithubLoginStatus & { reason?: string }> {
  const tries = Math.min(Math.max(opts.tries ?? 30, 1), 120)
  const interval = Math.min(Math.max(opts.intervalMs ?? 2000, 500), 10_000)
  let last: GithubLoginStatus & { reason?: string } = { authorized: false }
  for (let i = 0; i < tries; i++) {
    last = await githubLoginStatus(opts)
    if (last.authorized) return last
    if (i < tries - 1) await new Promise((r) => setTimeout(r, interval))
  }
  return last.authorized ? last : { authorized: false, reason: "timed out waiting for browser approval" }
}

/** Forget this machine's token server-side (revokes the loop, not the App). */
export async function githubLogout(opts: GithubAuthOptions = {}): Promise<{ ok: boolean; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { ok: false, reason: "cannot read machine identity" }
  }
  try {
    const { status } = await postAuth("/auth/github/logout", { machineId }, opts.serverUrl, opts.timeoutMs ?? 10_000)
    return status === 200 ? { ok: true } : { ok: false, reason: `HTTP ${status}` }
  } catch {
    return { ok: false, reason: "license server unreachable" }
  }
}

export interface GithubIssue {
  number: number
  title: string
  state: string
  author: string
  url: string
  body: string
  commentsCount: number
  isPullRequest: boolean
}

export interface GithubIssueComment {
  author: string
  body: string
  createdAt: string
}

/** Read an issue (+ recent comments) through the server's stored token. */
export async function readGithubIssue(
  repo: string,
  number: number,
  opts: GithubAuthOptions & { withComments?: boolean } = {},
): Promise<{ ok: boolean; issue?: GithubIssue; comments?: GithubIssueComment[]; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { ok: false, reason: "cannot read machine identity" }
  }
  try {
    const { status, json } = await postAuth(
      "/github/read",
      { machineId, repo, number, withComments: opts.withComments !== false },
      opts.serverUrl,
      opts.timeoutMs ?? 15_000,
    )
    if (status === 401) return { ok: false, reason: "GitHub login required — run /github login first" }
    if (status !== 200 || json.ok !== true) {
      const reason =
        typeof json.reason === "string" ? json.reason : typeof json.error === "string" ? json.error : `HTTP ${status}`
      return { ok: false, reason }
    }
    return {
      ok: true,
      issue: json.issue as GithubIssue,
      comments: Array.isArray(json.comments) ? (json.comments as GithubIssueComment[]) : [],
    }
  } catch {
    return { ok: false, reason: "license server unreachable" }
  }
}

export interface GithubRepo {
  fullName: string
  private: boolean
  defaultBranch: string
  updatedAt: string
}

/** 401 from the VPS write/read proxies always means the same thing. */
function loginRequired(status: number, reason: string): string {
  return status === 401 ? "GitHub login required — run /github login first" : reason
}

/** List the logged-in user's repos through the server's stored token —
 *  the agent's way to check "user ke handle se user ki repo". */
export async function listGithubRepos(
  opts: GithubAuthOptions = {},
): Promise<{ ok: boolean; login?: string; repos?: GithubRepo[]; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { ok: false, reason: "cannot read machine identity" }
  }
  try {
    const { status, json } = await getAuth(
      `/github/repos?machineId=${encodeURIComponent(machineId)}`,
      opts.serverUrl,
      opts.timeoutMs ?? 15_000,
    )
    if (status !== 200 || json.ok !== true) {
      const reason =
        typeof json.error === "string" ? json.error : typeof json.reason === "string" ? json.reason : `HTTP ${status}`
      return { ok: false, reason: loginRequired(status, reason) }
    }
    return {
      ok: true,
      login: typeof json.login === "string" ? json.login : undefined,
      repos: Array.isArray(json.repos) ? (json.repos as GithubRepo[]) : [],
    }
  } catch {
    return { ok: false, reason: "license server unreachable" }
  }
}

/** Write a repo file through the server's stored token (VPS-routed: the
 *  CLI never holds the OAuth token). Callers with a local GITHUB_TOKEN go
 *  direct instead — this is the logged-in fallback. */
export async function writeGithubFileViaServer(
  repo: string,
  filePath: string,
  content: string,
  message: string,
  branch: string | undefined,
  opts: GithubAuthOptions = {},
): Promise<{ ok: boolean; commit?: string | null; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { ok: false, reason: "cannot read machine identity" }
  }
  try {
    const { status, json } = await postAuth(
      "/github/write",
      { machineId, repo, path: filePath, content, message, ...(branch ? { branch } : {}) },
      opts.serverUrl,
      opts.timeoutMs ?? 20_000,
    )
    if (status !== 200 || json.ok !== true) {
      const reason =
        typeof json.error === "string" ? json.error : typeof json.reason === "string" ? json.reason : `HTTP ${status}`
      return { ok: false, reason: loginRequired(status, reason) }
    }
    return { ok: true, commit: typeof json.commit === "string" ? json.commit : null }
  } catch {
    return { ok: false, reason: "license server unreachable" }
  }
}

/** Create a repo branch through the server's stored token. */
export async function createGithubBranchViaServer(
  repo: string,
  branch: string,
  base: string | undefined,
  opts: GithubAuthOptions = {},
): Promise<{ ok: boolean; base?: string; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { ok: false, reason: "cannot read machine identity" }
  }
  try {
    const { status, json } = await postAuth(
      "/github/branch",
      { machineId, repo, branch, ...(base ? { base } : {}) },
      opts.serverUrl,
      opts.timeoutMs ?? 20_000,
    )
    if (status !== 200 || json.ok !== true) {
      const reason =
        typeof json.error === "string" ? json.error : typeof json.reason === "string" ? json.reason : `HTTP ${status}`
      return { ok: false, reason: loginRequired(status, reason) }
    }
    return { ok: true, base: typeof json.base === "string" ? json.base : undefined }
  } catch {
    return { ok: false, reason: "license server unreachable" }
  }
}

/** Open a repo PR through the server's stored token. */
export async function createGithubPrViaServer(
  repo: string,
  head: string,
  base: string | undefined,
  title: string,
  body: string,
  opts: GithubAuthOptions = {},
): Promise<{ ok: boolean; number?: number | null; url?: string; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { ok: false, reason: "cannot read machine identity" }
  }
  try {
    const { status, json } = await postAuth(
      "/github/pr",
      { machineId, repo, head, title, body, ...(base ? { base } : {}) },
      opts.serverUrl,
      opts.timeoutMs ?? 20_000,
    )
    if (status !== 200 || json.ok !== true) {
      const reason =
        typeof json.error === "string" ? json.error : typeof json.reason === "string" ? json.reason : `HTTP ${status}`
      return { ok: false, reason: loginRequired(status, reason) }
    }
    return {
      ok: true,
      number: typeof json.number === "number" ? json.number : null,
      url: typeof json.url === "string" ? json.url : undefined,
    }
  } catch {
    return { ok: false, reason: "license server unreachable" }
  }
}

/** Copy a repo file through the server's stored token. */
export async function copyGithubFileViaServer(
  repo: string,
  sourcePath: string,
  destPath: string,
  opts: GithubAuthOptions = {},
): Promise<{ ok: boolean; commit?: string | null; reason?: string }> {
  let machineId: string
  try {
    machineId = machine(opts)
  } catch {
    return { ok: false, reason: "cannot read machine identity" }
  }
  try {
    const { status, json } = await postAuth(
      "/github/copy",
      { machineId, repo, sourcePath, destPath },
      opts.serverUrl,
      opts.timeoutMs ?? 20_000,
    )
    if (status !== 200 || json.ok !== true) {
      const reason =
        typeof json.error === "string" ? json.error : typeof json.reason === "string" ? json.reason : `HTTP ${status}`
      return { ok: false, reason: loginRequired(status, reason) }
    }
    return { ok: true, commit: typeof json.commit === "string" ? json.commit : null }
  } catch {
    return { ok: false, reason: "license server unreachable" }
  }
}
