/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * GitHub App integration for VPS deployment (no new dependencies —
 * node:crypto for HMAC/JWT, global fetch for API calls).
 *
 * Flow: GitHub delivers a webhook to POST /webhooks/github → signature is
 * verified with GITHUB_WEBHOOK_SECRET → comment commands (`/nemo …`)
 * become agent jobs → the result lands back as an issue/PR comment.
 *
 * Pure where it matters (signature, command parse, routing are unit-tested
 * offline); only token minting and commenting touch the network.
 */

import { createHmac, createSign, timingSafeEqual } from "node:crypto"

/** Prefix GitHub puts in front of the hex HMAC-SHA256 digest. */
const SIGNATURE_PREFIX = "sha256="

/** A comment triggers the agent when it contains one of these prefixes.
 *  `/nemo` is the short form — same bot, less typing. */
const COMMAND_PREFIXES = ["/nemo", "@nemo"] as const

/**
 * Verify an X-Hub-Signature-256 header against the raw request body.
 * timingSafeEqual (never early-return compare) — the only safe shape.
 */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!secret || !signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false
  const hex = signatureHeader.slice(SIGNATURE_PREFIX.length)
  let theirs: Buffer
  try {
    theirs = Buffer.from(hex, "hex")
  } catch {
    return false
  }
  const ours = createHmac("sha256", secret).update(rawBody).digest()
  if (theirs.length !== ours.length) return false
  return timingSafeEqual(theirs, ours)
}

export interface NemoCommand {
  /** The task text after the prefix, trimmed. */
  task: string
}

/**
 * Extract `/nemo <task>` (or `@nemo <task>`) from a comment body.
 * Returns null for empty tasks, bare mentions, and non-command chatter.
 * The prefix match is case-insensitive (`/NEMO`, `@Nemo`, …) but the
 * task is sliced from the ORIGINAL body — its case is the user's content.
 */
export function parseNemoCommand(body: string): NemoCommand | null {
  if (!body) return null
  for (const prefix of COMMAND_PREFIXES) {
    const idx = body.search(new RegExp(escapeRegExp(prefix), "i"))
    if (idx < 0) continue
    const task = body.slice(idx + prefix.length).trim()
    if (!task) return null
    return { task }
  }
  return null
}

/** Escape a literal for RegExp construction (prefixes carry / and @). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export type GithubEventName =
  "ping" | "issue_comment" | "pull_request" | "pull_request_review_comment" | "push" | string

export interface GithubJob {
  /** "owner/repo" the event belongs to. */
  repoFullName: string
  /** Issue/PR number to report back to. */
  issueNumber: number
  /** Task text for the agent. */
  task: string
  /** True when the thread is a pull request (report framing). */
  isPullRequest: boolean
}

export type GithubRouteOutcome =
  { kind: "pong" } | { kind: "job"; job: GithubJob } | { kind: "ignored"; reason: string }

/**
 * Route a verified webhook payload to an outcome. Never throws — unknown
 * shapes and action filters land in `ignored` with a reason.
 */
export function routeGithubEvent(event: GithubEventName, payload: unknown): GithubRouteOutcome {
  if (event === "ping") return { kind: "pong" }
  if (typeof payload !== "object" || payload === null) {
    return { kind: "ignored", reason: "non-object payload" }
  }
  const body = payload as Record<string, unknown>
  const repo = body.repository as { full_name?: unknown } | undefined
  const repoFullName = typeof repo?.full_name === "string" ? repo.full_name : ""
  if (!repoFullName) return { kind: "ignored", reason: "missing repository.full_name" }

  if (event === "issue_comment" || event === "pull_request_review_comment") {
    const action = (body.action as string) ?? ""
    // Act only on creation — edits would double-fire jobs.
    if (action !== "" && action !== "created") {
      return { kind: "ignored", reason: `action=${action}` }
    }
    // Never answer our own (or any bot's) comments: agent replies echo the
    // triggering "/nemo …" text, and without this guard each reply
    // re-triggers a full job — an infinite self-spam loop (observed live:
    // back-to-back bot comments the user had to delete by hand).
    const commentUser = (body.comment as { user?: { type?: unknown } } | undefined)?.user
    const senderType = (body.sender as { type?: unknown } | undefined)?.type
    if (commentUser?.type === "Bot" || senderType === "Bot") {
      return { kind: "ignored", reason: "bot comment (self-trigger guard)" }
    }
    const comment = body.comment as { body?: unknown } | undefined
    const command = parseNemoCommand(typeof comment?.body === "string" ? comment.body : "")
    if (!command) return { kind: "ignored", reason: "no /nemo command" }
    const issue = body.issue as { number?: unknown } | undefined
    const issueNumber = typeof issue?.number === "number" ? issue.number : 0
    if (!issueNumber) return { kind: "ignored", reason: "missing issue.number" }
    const isPullRequest =
      event === "pull_request_review_comment" ||
      (body.issue as { pull_request?: unknown } | undefined)?.pull_request !== undefined
    return { kind: "job", job: { repoFullName, issueNumber, task: command.task, isPullRequest } }
  }

  if (event === "pull_request") {
    // v1 does not auto-run on PR open/sync — a human must ask via comment.
    // (Unattended runs on untrusted fork code is a prompt-injection hole.)
    return { kind: "ignored", reason: "pull_request needs an explicit /nemo comment" }
  }

  if (event === "push") {
    return { kind: "ignored", reason: "push events not subscribed in v1" }
  }

  return { kind: "ignored", reason: `unsupported event ${event}` }
}

/**
 * Thread context for the job prompt: the webhook already carries the issue
 * title/body and the triggering comment — hand them to the agent verbatim
 * so trivial tasks ("hello", questions) resolve with zero API calls, and
 * deeper work starts informed instead of blind.
 */
export function describeGithubThread(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return ""
  const body = payload as Record<string, unknown>
  const issue = body.issue as { number?: unknown; title?: unknown; body?: unknown } | undefined
  const comment = body.comment as { body?: unknown; user?: { login?: unknown } } | undefined
  const lines: string[] = []
  if (issue && (typeof issue.title === "string" || typeof issue.body === "string")) {
    const title = typeof issue.title === "string" ? issue.title : "(no title)"
    const ibody = typeof issue.body === "string" ? issue.body.slice(0, 2000) : ""
    lines.push(`Issue #${typeof issue.number === "number" ? issue.number : "?"}: ${title}`)
    if (ibody.trim()) lines.push(`Issue body:\n${ibody}`)
  }
  if (comment && typeof comment.body === "string" && comment.body.trim()) {
    const who = (comment.user as { login?: unknown } | undefined)?.login
    lines.push(`Triggering comment${typeof who === "string" ? ` by ${who}` : ""}:\n${comment.body.slice(0, 1000)}`)
  }
  return lines.join("\n\n")
}

/**
 * Squeeze a human-readable reply out of agent messages for thread comments.
 * Prefers the last assistant text; falls back to the last tool result text
 * (agentic models often answer tool-only); never returns empty — the caller
 * posts SOMETHING so threads never show a confusing blank reply.
 */
export function extractFinalReply(messages: Array<{ role?: string; content?: unknown }>): string {
  const textOf = (content: unknown): string => {
    if (!Array.isArray(content)) return ""
    return content
      .filter(
        (p): p is { type: "text"; text: string } =>
          !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
      )
      .map((p) => p.text)
      .join("\n")
      .trim()
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === "assistant") {
      const t = textOf(m.content)
      if (t) return t
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === "tool") {
      const t = textOf(m.content)
      if (t) return `(no direct answer; last tool result)\n\n${t}`.slice(0, 60000)
    }
  }
  return "(agent produced no text output)"
}

/**
 * Pick the thread reply for a finished GitHub job. Thrown runs and empty
 * runs surface the provider's own error text (captured from the error
 * message_end emits — those never enter the session, so without this the
 * thread shows a blank reply while the real error evaporates into a
 * no-op emit sink). Never returns empty.
 */
export function selectJobReply(
  messages: Array<{ role?: string; content?: unknown }>,
  runError: string,
  errorTexts: string[],
): string {
  if (runError) return `Agent run failed: ${runError}`.slice(0, 2000)
  const reply = extractFinalReply(messages)
  if (reply !== "(agent produced no text output)") return reply
  if (errorTexts.length > 0) return errorTexts.join("\n").slice(0, 2000)
  return reply
}

export interface ApiClient {
  apiBase: string
  token: string
}

const GITHUB_API_ORIGIN = "https://api.github.com"

/**
 * GitHub API origin. GITHUB_API_BASE may only name the public API — the value
 * is never used to build a request URL, so a misconfigured (or hostile) env var
 * cannot redirect the installation token to another host.
 */
export function resolveApiBase(raw: string | undefined): string {
  const candidate = (raw ?? "").trim()
  if (!candidate) return GITHUB_API_ORIGIN
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`invalid GITHUB_API_BASE: ${candidate}`)
  }
  const isPublic =
    parsed.protocol === "https:" &&
    parsed.hostname === "api.github.com" &&
    !parsed.port &&
    !parsed.username &&
    !parsed.password &&
    parsed.pathname.replace(/\/+$/, "") === "" &&
    !parsed.search &&
    !parsed.hash
  if (!isPublic) {
    throw new Error("GITHUB_API_BASE must be https://api.github.com (GitHub Enterprise is not supported)")
  }
  return GITHUB_API_ORIGIN
}

function apiHeaders(client: ApiClient): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${client.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  }
}

/** Post a comment on an issue or pull request. Throws on non-2xx. */
export async function postIssueComment(
  client: ApiClient,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  resolveApiBase(client.apiBase)
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`bad repo slug: ${owner}/${repo}`)
  }
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`bad issue number: ${issueNumber}`)
  }
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`
  const res = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
    method: "POST",
    headers: apiHeaders(client),
    body: JSON.stringify({ body }),
  })
  if (!res.ok) {
    throw new Error(`comment post failed: ${res.status} ${await res.text().catch(() => "")}`.trim())
  }
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Mint a GitHub App JWT (RS256, 10-minute life) with node:crypto only.
 * Exchange it at /app/installations/{id}/access_tokens for a scoped token.
 */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })))
  const payload = base64url(Buffer.from(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId })))
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${payload}`)
  signer.end()
  const signature = base64url(signer.sign(privateKeyPem))
  return `${header}.${payload}.${signature}`
}

/** Exchange an App JWT for an installation access token. */
export async function createInstallationToken(apiBase: string, jwt: string, installationId: number): Promise<string> {
  resolveApiBase(apiBase)
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`bad installation id: ${installationId}`)
  }
  const res = await fetch(`${GITHUB_API_ORIGIN}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!res.ok) {
    throw new Error(`installation token failed: ${res.status}`)
  }
  const data = (await res.json()) as { token?: unknown }
  if (typeof data.token !== "string" || !data.token) {
    throw new Error("installation token response missing token")
  }
  return data.token
}

/** Split "owner/repo" (throws on malformed input — fail closed). */
export function splitRepo(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/")
  if (!owner || !repo) throw new Error(`bad repo full_name: ${fullName}`)
  return { owner, repo }
}
