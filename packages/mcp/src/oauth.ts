/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * OAuth 2.0 + PKCE authorization for remote MCP servers.
 *
 * Ported from Shrijan Code's MCP auth stack (`mcp/auth.ts`, `mcp/oauth-provider.ts`,
 * `mcp/oauth-callback.ts`) adapted to nemo's hand-rolled MCP client:
 *
 * - a file-backed token store (`~/.nemo/mcp-auth.json`, Shrijan-parity schema),
 * - RFC 8414 metadata discovery with well-known fallbacks,
 * - RFC 7591 dynamic client registration (when the server supports it),
 * - Authorization Code flow with PKCE S256 + CSRF `state`,
 * - a loopback callback server (see `oauth-callback.ts`),
 * - refresh-token renewal before requests when the access token is expired.
 */

import { spawn } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as http from "http"
import * as https from "https"
import * as os from "os"
import * as path from "path"
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_TIMEOUT_MS,
  cancelPending,
  ensureRunning,
  waitForCallback,
} from "./oauth-callback.js"

/** Per-server OAuth tuning. All fields optional: discovery + dynamic registration fill the gaps. */
export interface McpOAuthConfig {
  clientId?: string
  clientSecret?: string
  scope?: string
  callbackPort?: number
  redirectUri?: string
}

export interface McpOAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Absolute expiry in epoch **seconds** (Shrijan-faithful). */
  expiresAt?: number
  scope?: string
}

export interface McpOAuthClientInfo {
  clientId: string
  clientSecret?: string
  clientIdIssuedAt?: number
  /** Epoch seconds; `0`/absent means the secret never expires (RFC 7591). */
  clientSecretExpiresAt?: number
}

/** One stored entry per MCP server name, mirroring Shrijan's `mcp-auth.json` shape. */
export interface McpAuthEntry {
  tokens?: McpOAuthTokens
  clientInfo?: McpOAuthClientInfo
  serverUrl?: string
}

export type McpAuthStatus = "authenticated" | "expired" | "not_authenticated"

export type McpAuthErrorKind = "discovery" | "registration" | "authorization" | "callback" | "token" | "auth-required"

/** Raised when a remote MCP server demands OAuth and the flow cannot (or must not) complete. */
export class McpAuthError extends Error {
  readonly kind: McpAuthErrorKind
  readonly authorizationUrl?: string

  constructor(message: string, kind: McpAuthErrorKind, authorizationUrl?: string) {
    super(message)
    this.name = "McpAuthError"
    this.kind = kind
    this.authorizationUrl = authorizationUrl
  }
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

/** Absolute path of the token store. `NEMO_MCP_AUTH_FILE` overrides it (tests). */
export function authFilePath(): string {
  return process.env.NEMO_MCP_AUTH_FILE || path.join(os.homedir(), ".nemo", "mcp-auth.json")
}

function readAuthStore(): Record<string, McpAuthEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath(), "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, McpAuthEntry>
    }
  } catch {
    /* missing or corrupt file - start fresh */
  }
  return {}
}

function writeAuthStore(data: Record<string, McpAuthEntry>): void {
  const file = authFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort - not all platforms support chmod */
  }
}

export function getAuthEntry(name: string): McpAuthEntry | undefined {
  return readAuthStore()[name]
}

/** Like `getAuthEntry`, but drops entries recorded for a different server URL (Shrijan's `getForUrl`). */
export function getAuthEntryForUrl(name: string, serverUrl: string): McpAuthEntry | undefined {
  const entry = readAuthStore()[name]
  if (!entry) return undefined
  if (entry.serverUrl && entry.serverUrl !== serverUrl) return undefined
  return entry
}

export function setAuthEntry(name: string, entry: McpAuthEntry): void {
  const store = readAuthStore()
  store[name] = entry
  writeAuthStore(store)
}

/** Forget all stored credentials for a server and cancel any in-flight authorization. */
export function removeMcpAuth(name: string): boolean {
  const store = readAuthStore()
  if (!(name in store)) {
    cancelPending(name)
    return false
  }
  delete store[name]
  writeAuthStore(store)
  cancelPending(name)
  return true
}

/** Shrijan-parity auth status: authenticated / expired / not_authenticated. */
export function getMcpAuthStatus(name: string, serverUrl?: string): McpAuthStatus {
  const entry = serverUrl ? getAuthEntryForUrl(name, serverUrl) : getAuthEntry(name)
  if (!entry?.tokens) return "not_authenticated"
  const expiresAt = entry.tokens.expiresAt
  if (expiresAt && expiresAt < Math.floor(Date.now() / 1000)) return "expired"
  return "authenticated"
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636)
// ---------------------------------------------------------------------------

/** 64-char base64url verifier (43-128 chars allowed by the RFC). */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(48).toString("base64url")
}

/** S256 code challenge: base64url(sha256(verifier)). */
export function computeCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url")
}

/** 64-hex-char CSRF state, matching Shrijan's generator. */
export function generateState(): string {
  return crypto.randomBytes(32).toString("hex")
}

// ---------------------------------------------------------------------------
// Tiny HTTP JSON/form helper
// ---------------------------------------------------------------------------

interface HttpTextResponse {
  status: number
  text: string
  json?: Record<string, unknown>
}

function httpRequest(
  target: string,
  opts: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  } = {},
): Promise<HttpTextResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      reject(new Error(`Invalid URL: ${target}`))
      return
    }
    const lib = parsed.protocol === "https:" ? https : http
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers: opts.headers,
        timeout: opts.timeoutMs ?? 15_000,
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () => {
          let json: Record<string, unknown> | undefined
          try {
            const parsedBody = JSON.parse(text)
            if (parsedBody && typeof parsedBody === "object") json = parsedBody as Record<string, unknown>
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, text, json })
        })
      },
    )
    req.on("error", (err) => reject(err))
    req.on("timeout", () => {
      req.destroy()
      reject(new Error(`Timeout requesting ${target}`))
    })
    req.end(opts.body)
  })
}

// ---------------------------------------------------------------------------
// Metadata discovery (RFC 8414 + OpenID fallback)
// ---------------------------------------------------------------------------

/**
 * Narrow a requested scope to what the server actually supports.
 *
 * Why this exists
 * ---------------
 * `runAuthorize` had the server's own `scopes_supported` list in hand — it is
 * fetched at the top of that function — and sent `config.scope` verbatim anyway.
 * Two distinct failures follow, and they point in opposite directions:
 *
 *  - **A request that cannot succeed.** Config says `read write`, the server
 *    supports `read`. The authorization endpoint rejects the whole thing with
 *    `invalid_scope`, and the user is sent to a browser to watch it fail. The
 *    answer was sitting in the same function.
 *  - **Asking for more than intended.** Config says `admin delete read`, the
 *    server supports only `read`. Requesting `admin` is a claim about privilege
 *    the server will refuse — and on servers that quietly ignore scope components
 *    they do not recognise, the resulting token can carry scopes nobody asked
 *    for. Intersecting is the least-privilege behaviour as well as the correct one.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * Treat absence as permission. `scopes_supported` is OPTIONAL in RFC 8414, so a
 * server that omits it is not claiming to support everything and is not claiming
 * to support only what was asked. An absent list means "unknown", and the
 * requested scope passes through untouched. Assuming an empty list means
 * "nothing is allowed" would break every server that legitimately omits the
 * field, which is most of them.
 *
 * @param requested space-delimited scope string; may be undefined or empty
 * @param supported the server's advertised list, or undefined when it omitted one
 */
export function resolveScopes(requested: string | undefined, supported: string[] | undefined): string | undefined {
  const wanted = (requested ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (wanted.length === 0) return undefined

  // No USABLE advertisement: nothing to narrow against, and RFC 8414 makes the
  // field optional. The check is on the filtered names rather than the array
  // length, because a server emitting `"scopes_supported": ["", "  "]` has not
  // told us anything — testing the length would treat a list of blanks as an
  // authoritative "nothing is supported" and deny a request on the strength of
  // noise.
  const allowed = usableScopeSet(supported)
  if (allowed.size === 0) return wanted.join(" ")

  // Order follows the REQUEST, not the server's list, so the resulting string is
  // stable for a given config — a scope string that reorders run to run makes a
  // cache key useless and a failing request impossible to diff.
  const kept = wanted.filter((s) => allowed.has(s))
  return kept.length > 0 ? kept.join(" ") : undefined
}

/**
 * The server's advertised scope names, blanks discarded.
 *
 * Empty means "the server did not tell us", which callers must treat as UNKNOWN
 * rather than as an empty allow-list. That distinction is the whole reason this
 * exists instead of an inline filter.
 */
function usableScopeSet(supported: string[] | undefined): Set<string> {
  if (!Array.isArray(supported)) return new Set()
  return new Set(supported.map((s) => s.trim()).filter((s) => s.length > 0))
}

/**
 * What a narrowing dropped, and whether anything survived.
 *
 * Separate from the returned string because the two cases want different
 * messages: "narrowed to X" is a routine adjustment the user need not see, while
 * "nothing survived" is a misconfiguration the operator has to fix. Collapsing
 * them into one undefined return loses that distinction.
 */
export function describeScopeDrop(
  requested: string | undefined,
  supported: string[] | undefined,
): { dropped: string[]; nothingSurvived: boolean } {
  const allowed = usableScopeSet(supported)
  if (allowed.size === 0) return { dropped: [], nothingSurvived: false }
  const wanted = (requested ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const kept = wanted.filter((s) => allowed.has(s))
  return {
    dropped: wanted.filter((s) => !allowed.has(s)),
    nothingSurvived: wanted.length > 0 && kept.length === 0,
  }
}

export interface OAuthMetadata {
  authorization_endpoint: string
  token_endpoint?: string
  registration_endpoint?: string
  scopes_supported?: string[]
}

const META_TTL_MS = 10 * 60_000
const metaCache = new Map<string, { at: number; meta: OAuthMetadata }>()

/** Ordered well-known candidate URLs for a given MCP endpoint. */
export function discoveryCandidates(serverUrl: string): string[] {
  const parsed = new URL(serverUrl)
  parsed.search = ""
  parsed.hash = ""
  const origin = parsed.origin
  const pathname = parsed.pathname.replace(/\/+$/, "")
  const candidates = new Set<string>()
  if (pathname) {
    // RFC 8414 path-aware discovery, then the MCP-draft "well-known inside the path" form.
    candidates.add(`${origin}/.well-known/oauth-authorization-server${pathname}`)
    candidates.add(`${origin}${pathname}/.well-known/oauth-authorization-server`)
  }
  candidates.add(`${origin}/.well-known/oauth-authorization-server`)
  candidates.add(`${origin}/.well-known/openid-configuration`)
  return Array.from(candidates)
}

/** Discover OAuth metadata for an MCP server URL (cached for 10 minutes). */
export async function discoverOAuthMetadata(serverUrl: string): Promise<OAuthMetadata> {
  const cached = metaCache.get(serverUrl)
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.meta

  const problems: string[] = []
  for (const candidate of discoveryCandidates(serverUrl)) {
    try {
      const res = await httpRequest(candidate, { headers: { Accept: "application/json" } })
      if (res.status >= 200 && res.status < 300 && res.json) {
        const meta = res.json as unknown as OAuthMetadata
        if (typeof meta.authorization_endpoint === "string" && meta.authorization_endpoint.length > 0) {
          metaCache.set(serverUrl, { at: Date.now(), meta })
          return meta
        }
        problems.push(`${candidate}: metadata missing authorization_endpoint`)
      } else if (res.status !== 404 && res.status !== 401 && res.status !== 403) {
        problems.push(`${candidate}: HTTP ${res.status}`)
      }
    } catch (err) {
      problems.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new McpAuthError(
    `No OAuth metadata found for MCP server at ${serverUrl} (${problems.join("; ") || "no endpoints responded"}).`,
    "discovery",
  )
}

// ---------------------------------------------------------------------------
// Client registration (RFC 7591) + client resolution
// ---------------------------------------------------------------------------

/** RFC 7591 client metadata sent during dynamic registration (Shrijan-parity fields). */
export function clientMetadata(redirectUri: string, config: McpOAuthConfig): Record<string, unknown> {
  return {
    redirect_uris: [redirectUri],
    client_name: "nemo",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: config.clientSecret ? "client_secret_post" : "none",
    ...(config.scope ? { scope: config.scope } : {}),
  }
}

export async function registerClient(
  registrationEndpoint: string,
  metadata: Record<string, unknown>,
): Promise<McpOAuthClientInfo> {
  const res = await httpRequest(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(metadata),
  })
  const json = res.json
  if (!(res.status >= 200 && res.status < 300) || typeof json?.client_id !== "string") {
    throw new McpAuthError(
      `MCP server does not support dynamic client registration (HTTP ${res.status}). Provide clientId in the server's oauth config.`,
      "registration",
    )
  }
  return {
    clientId: json.client_id,
    clientSecret: typeof json.client_secret === "string" ? json.client_secret : undefined,
    clientIdIssuedAt: typeof json.client_id_issued_at === "number" ? json.client_id_issued_at : undefined,
    clientSecretExpiresAt:
      typeof json.client_secret_expires_at === "number" ? json.client_secret_expires_at : undefined,
  }
}

/** Config-provided credentials win, then stored registration (unless its secret expired). */
function resolveClientInfo(name: string, serverUrl: string, config: McpOAuthConfig): McpOAuthClientInfo | undefined {
  if (config.clientId) {
    return { clientId: config.clientId, clientSecret: config.clientSecret }
  }
  const info = getAuthEntryForUrl(name, serverUrl)?.clientInfo
  if (!info) return undefined
  if (info.clientSecretExpiresAt && info.clientSecretExpiresAt < Math.floor(Date.now() / 1000)) {
    return undefined
  }
  return info
}

// ---------------------------------------------------------------------------
// Authorization URL + token endpoints
// ---------------------------------------------------------------------------

export function buildAuthorizationUrl(
  authorizationEndpoint: string,
  params: {
    clientId: string
    redirectUri: string
    state: string
    codeChallenge: string
    scope?: string
  },
): string {
  const target = new URL(authorizationEndpoint)
  target.searchParams.set("response_type", "code")
  target.searchParams.set("client_id", params.clientId)
  target.searchParams.set("redirect_uri", params.redirectUri)
  target.searchParams.set("state", params.state)
  target.searchParams.set("code_challenge", params.codeChallenge)
  target.searchParams.set("code_challenge_method", "S256")
  if (params.scope) target.searchParams.set("scope", params.scope)
  return target.toString()
}

async function tokenRequest(tokenEndpoint: string, params: Record<string, string>): Promise<McpOAuthTokens> {
  const body = new URLSearchParams(params).toString()
  const res = await httpRequest(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  })
  const json = res.json
  if (!(res.status >= 200 && res.status < 300) || json?.error) {
    const detail =
      (typeof json?.error_description === "string" && json.error_description) ||
      (typeof json?.error === "string" && json.error) ||
      `HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 200)}` : ""}`
    throw new McpAuthError(`Token request failed: ${detail}`, "token")
  }
  if (typeof json?.access_token !== "string" || !json.access_token) {
    throw new McpAuthError("Token response did not include an access_token.", "token")
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: typeof json.expires_in === "number" ? Math.floor(Date.now() / 1000) + json.expires_in : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
  }
}

export function exchangeAuthorizationCode(
  tokenEndpoint: string,
  params: {
    code: string
    redirectUri: string
    clientId: string
    clientSecret?: string
    codeVerifier: string
  },
): Promise<McpOAuthTokens> {
  return tokenRequest(tokenEndpoint, {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
  })
}

export function refreshAccessToken(
  tokenEndpoint: string,
  params: { clientId: string; clientSecret?: string; refreshToken: string },
): Promise<McpOAuthTokens> {
  return tokenRequest(tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
  })
}

// ---------------------------------------------------------------------------
// Access-token retrieval (with proactive refresh)
// ---------------------------------------------------------------------------

const inflightRefresh = new Map<string, Promise<string | undefined>>()
/** Refresh 60s before expiry so racing requests never use a token that dies mid-flight. */
const REFRESH_SKEW_SECONDS = 60

/**
 * Return a valid access token for the server, refreshing proactively when the
 * stored token is (nearly) expired. Returns `undefined` when nothing is stored
 * or refresh is impossible - callers treat a subsequent 401 as "run the flow".
 */
export async function getValidAccessToken(
  name: string,
  serverUrl: string,
  config: McpOAuthConfig = {},
): Promise<string | undefined> {
  const tokens = getAuthEntryForUrl(name, serverUrl)?.tokens
  if (!tokens) return undefined

  const nowSec = Math.floor(Date.now() / 1000)
  const needsRefresh = Boolean(tokens.expiresAt) && (tokens.expiresAt as number) - REFRESH_SKEW_SECONDS <= nowSec
  if (!needsRefresh || !tokens.refreshToken) return tokens.accessToken

  const inflight = inflightRefresh.get(name)
  if (inflight) return inflight

  const task = (async (): Promise<string | undefined> => {
    try {
      const meta = await discoverOAuthMetadata(serverUrl)
      if (!meta.token_endpoint) return tokens.accessToken
      const client = resolveClientInfo(name, serverUrl, config)
      if (!client) return tokens.accessToken
      const fresh = await refreshAccessToken(meta.token_endpoint, {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: tokens.refreshToken as string,
      })
      const entry = getAuthEntryForUrl(name, serverUrl) ?? { serverUrl }
      setAuthEntry(name, {
        ...entry,
        tokens: { ...fresh, refreshToken: fresh.refreshToken ?? tokens.refreshToken },
        serverUrl,
      })
      return fresh.accessToken
    } catch {
      // Keep serving the stale token; the server's 401 triggers the full flow.
      return tokens.accessToken
    } finally {
      inflightRefresh.delete(name)
    }
  })()
  inflightRefresh.set(name, task)
  return task
}

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

/** Open the system browser at `target`. Returns false when launching is suppressed/fails. */
export function openSystemBrowser(target: string): boolean {
  if (process.env.NEMO_NO_BROWSER === "1") return false
  try {
    if (process.platform === "win32") {
      // rundll32 avoids cmd.exe's `&`/quote parsing entirely (URLs carry query strings).
      spawn("rundll32", ["url.dll,FileProtocolHandler", target], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref()
      return true
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open"
    spawn(opener, [target], { detached: true, stdio: "ignore" }).unref()
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Full interactive authorization flow
// ---------------------------------------------------------------------------

export interface AuthorizeOptions {
  /** Override browser launch (tests inject a fetch-based opener). */
  open?: (authorizationUrl: string) => boolean | Promise<boolean>
  /** Override the "visit this URL" notice (defaults to stderr, Ink-safe). */
  onNotice?: (message: string) => void
  /** How long to wait for the callback (default: 5 minutes). */
  waitMs?: number
}

const inflightAuth = new Map<string, Promise<boolean>>()

/**
 * Run the full OAuth 2.0 + PKCE flow for a remote MCP server:
 * discovery -> callback bind -> (dynamic registration) -> browser -> callback
 * -> code exchange -> token store. Concurrent calls for the same server share
 * one flow. Resolves true once tokens are stored.
 */
export function authorizeMcpServer(
  name: string,
  serverUrl: string,
  config: McpOAuthConfig = {},
  opts: AuthorizeOptions = {},
): Promise<boolean> {
  const existing = inflightAuth.get(name)
  if (existing) return existing
  const task = runAuthorize(name, serverUrl, config, opts).finally(() => {
    inflightAuth.delete(name)
  })
  inflightAuth.set(name, task)
  return task
}

async function runAuthorize(
  name: string,
  serverUrl: string,
  config: McpOAuthConfig,
  opts: AuthorizeOptions,
): Promise<boolean> {
  const meta = await discoverOAuthMetadata(serverUrl)

  // Bind the callback first: the effective redirect URI feeds both dynamic
  // registration and the authorization request (Shrijan binds it the same way).
  const callback = await ensureRunning(
    config.redirectUri ??
      (config.callbackPort ? `http://127.0.0.1:${config.callbackPort}${OAUTH_CALLBACK_PATH}` : undefined),
  )
  const redirectUri = callback.redirectUri

  let clientInfo = resolveClientInfo(name, serverUrl, config)
  const persistClientInfo = !clientInfo
  if (!clientInfo) {
    if (!meta.registration_endpoint) {
      throw new McpAuthError(
        `MCP server '${name}' does not support dynamic client registration. Provide clientId (and clientSecret) in its oauth config.`,
        "registration",
      )
    }
    clientInfo = await registerClient(meta.registration_endpoint, clientMetadata(redirectUri, config))
  }

  if (!meta.token_endpoint) {
    throw new McpAuthError(`OAuth metadata for '${name}' is missing a token_endpoint.`, "discovery")
  }

  const state = generateState()
  const verifier = generateCodeVerifier()

  // The server told us what it supports, in `meta`, fetched above. Sending the
  // configured scope verbatim instead is either a request that will be rejected
  // or a claim of privilege the operator did not intend.
  const narrowing = describeScopeDrop(config.scope, meta.scopes_supported)
  if (narrowing.nothingSurvived) {
    throw new McpAuthError(
      `None of the configured scopes for '${name}' are supported by the server ` +
        `(configured: ${config.scope ?? ""}; supported: ${(meta.scopes_supported ?? []).join(" ") || "none advertised"}).`,
      "discovery",
    )
  }
  const scope = resolveScopes(config.scope, meta.scopes_supported)

  const authorizationUrl = buildAuthorizationUrl(meta.authorization_endpoint, {
    clientId: clientInfo.clientId,
    redirectUri,
    state,
    codeChallenge: computeCodeChallenge(verifier),
    scope,
  })

  const waitMs = opts.waitMs ?? OAUTH_CALLBACK_TIMEOUT_MS
  const pending = waitForCallback(state, name, waitMs)

  const notice =
    opts.onNotice ??
    ((message: string) => {
      try {
        process.stderr.write(message + "\n")
      } catch {
        /* stderr may be closed */
      }
    })
  notice(
    `MCP '${name}' requires authorization.\n` +
      `If the browser did not open automatically, visit:\n  ${authorizationUrl}\n` +
      `Waiting for approval...`,
  )

  const open = opts.open ?? openSystemBrowser
  try {
    await open(authorizationUrl)
  } catch {
    /* the notice already contains the URL */
  }

  let code: string
  try {
    code = await pending
  } catch (err) {
    throw new McpAuthError(err instanceof Error ? err.message : String(err), "callback", authorizationUrl)
  }

  const tokens = await exchangeAuthorizationCode(meta.token_endpoint, {
    code,
    redirectUri,
    clientId: clientInfo.clientId,
    clientSecret: clientInfo.clientSecret,
    codeVerifier: verifier,
  })

  const existing = getAuthEntryForUrl(name, serverUrl) ?? {}
  setAuthEntry(name, {
    ...existing,
    ...(persistClientInfo && clientInfo ? { clientInfo } : {}),
    tokens,
    serverUrl,
  })
  return true
}

/** Clear discovery cache and in-flight maps (tests / `mcp logout` hygiene). */
export function clearOAuthCaches(): void {
  metaCache.clear()
  inflightAuth.clear()
  inflightRefresh.clear()
}
