/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as http from "http"
import * as os from "os"
import * as path from "path"
import {
  McpAuthError,
  authFilePath,
  authorizeMcpServer,
  buildAuthorizationUrl,
  clearOAuthCaches,
  clientMetadata,
  computeCodeChallenge,
  discoverOAuthMetadata,
  discoveryCandidates,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateState,
  getAuthEntry,
  getAuthEntryForUrl,
  getMcpAuthStatus,
  getValidAccessToken,
  registerClient,
  removeMcpAuth,
  setAuthEntry,
} from "./oauth.js"
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORT,
  ensureRunning,
  isRunning,
  parseRedirectUri,
  stop,
  waitForCallback,
} from "./oauth-callback.js"
import { createMcpConnection } from "./index.js"

vi.setConfig({ testTimeout: 15_000 })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestServer {
  base: string
  port: number
  requests: Array<{ url: string; method: string; headers: http.IncomingHttpHeaders; body: string }>
  close(): Promise<void>
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(obj))
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const requests: TestServer["requests"] = []
    const server = http.createServer((req, res) => {
      let body = ""
      req.setEncoding("utf8")
      req.on("data", (c: string) => (body += c))
      req.on("end", () => {
        requests.push({ url: req.url || "/", method: req.method || "GET", headers: req.headers, body })
        try {
          handler(req, res, body)
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/plain" })
          res.end(err instanceof Error ? err.message : String(err))
        }
      })
    })
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("no port"))
        return
      }
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

interface FakeAuthServer extends TestServer {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  registerBodies: Array<Record<string, unknown>>
  tokenRequests: URLSearchParams[]
}

/** Full fake OAuth 2.0 authorization server: discovery + register + authorize + token. */
function startFakeAuthServer(opts: { registration?: boolean; autoRedirect?: boolean } = {}): Promise<FakeAuthServer> {
  const registration = opts.registration !== false
  const autoRedirect = opts.autoRedirect !== false
  const registerBodies: Array<Record<string, unknown>> = []
  const tokenRequests: URLSearchParams[] = []
  // Set as soon as the server is bound; the handler only runs on real requests,
  // which always happen after `await startFakeAuthServer()` resolved.
  let boundPort = 0

  return startServer((req, res, body) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1")
    const origin = `http://127.0.0.1:${boundPort}`

    if (requestUrl.pathname === "/.well-known/oauth-authorization-server") {
      sendJson(res, 200, {
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(registration ? { registration_endpoint: `${origin}/register` } : {}),
        scopes_supported: ["mcp:tools"],
      })
      return
    }
    if (requestUrl.pathname === "/register") {
      if (!registration) {
        sendJson(res, 404, { error: "unsupported_registration" })
        return
      }
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        /* keep empty */
      }
      registerBodies.push(parsed)
      sendJson(res, 201, {
        client_id: "dyn-client",
        client_secret: "dyn-secret",
        client_id_issued_at: 1700000000,
        client_secret_expires_at: 0,
      })
      return
    }
    if (requestUrl.pathname === "/authorize") {
      if (!autoRedirect) {
        res.writeHead(200, { "Content-Type": "text/plain" })
        res.end("Approve manually in the browser.")
        return
      }
      const redirectUri = requestUrl.searchParams.get("redirect_uri")
      const state = requestUrl.searchParams.get("state")
      if (!redirectUri || !state) {
        res.writeHead(400)
        res.end("missing redirect_uri/state")
        return
      }
      const location = `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}code=authcode-123&state=${encodeURIComponent(state)}`
      res.writeHead(302, { Location: location })
      res.end()
      return
    }
    if (requestUrl.pathname === "/token") {
      const form = new URLSearchParams(body)
      tokenRequests.push(form)
      if (form.get("code") === "bad-code") {
        sendJson(res, 400, { error: "invalid_grant", error_description: "Code expired" })
        return
      }
      if (form.get("grant_type") === "refresh_token") {
        sendJson(res, 200, {
          access_token: "tok-refresh",
          refresh_token: "ref-new",
          token_type: "Bearer",
          expires_in: 3600,
        })
        return
      }
      sendJson(res, 200, {
        access_token: "tok-1",
        refresh_token: "ref-1",
        token_type: "Bearer",
        expires_in: 3600,
      })
      return
    }
    res.writeHead(404)
    res.end("Not found")
  }).then((server) => {
    boundPort = server.port
    const fake = server as FakeAuthServer
    fake.authorizationEndpoint = `${server.base}/authorize`
    fake.tokenEndpoint = `${server.base}/token`
    fake.registrationEndpoint = `${server.base}/register`
    fake.registerBodies = registerBodies
    fake.tokenRequests = tokenRequests
    return fake
  })
}

/** JSON-RPC-speaking fake MCP server with optional bearer-token gate / 500 mode. */
function startMcpLikeServer(opts: { auth?: string; status500?: boolean } = {}): Promise<TestServer> {
  return startServer((req, res, body) => {
    if (opts.status500) {
      res.writeHead(500, { "Content-Type": "text/plain" })
      res.end("boom")
      return
    }
    if (opts.auth && req.headers.authorization !== `Bearer ${opts.auth}`) {
      res.writeHead(401, { "Content-Type": "application/json" })
      res.end("{}")
      return
    }
    let msg: { id?: number; method?: string }
    try {
      msg = JSON.parse(body) as { id?: number; method?: string }
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const result =
      msg.method === "tools/list"
        ? {
            tools: [
              {
                name: "echo",
                description: "Echo input",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
              },
            ],
          }
        : {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "1.0.0" },
          }
    sendJson(res, 200, { jsonrpc: "2.0", id: msg.id, result })
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      const port = address && typeof address !== "string" ? address.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))))
    })
  })
}

function forceNonTty(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
  return () => {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  }
}

// ---------------------------------------------------------------------------
// Isolation: auth file per test, callback server + caches reset between tests
// ---------------------------------------------------------------------------

let authFile: string

beforeEach(() => {
  authFile = path.join(os.tmpdir(), `trayambak-mcp-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  process.env.TRAYAMBAK_MCP_AUTH_FILE = authFile
  clearOAuthCaches()
})

afterEach(async () => {
  await stop()
  clearOAuthCaches()
  delete process.env.TRAYAMBAK_MCP_AUTH_FILE
  try {
    fs.unlinkSync(authFile)
  } catch {
    /* already gone */
  }
})

// ---------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------

describe("PKCE", () => {
  it("generates RFC 7636 compliant verifiers", () => {
    for (let i = 0; i < 5; i++) {
      const verifier = generateCodeVerifier()
      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(verifier.length).toBeLessThanOrEqual(128)
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it("computes the S256 challenge from the RFC 7636 test vector", () => {
    expect(computeCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    )
  })

  it("generates unique 64-hex-char CSRF states", () => {
    const a = generateState()
    const b = generateState()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// parseRedirectUri
// ---------------------------------------------------------------------------

describe("parseRedirectUri", () => {
  it("returns defaults when no URI is configured", () => {
    expect(parseRedirectUri()).toEqual({ port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH })
    expect(parseRedirectUri(undefined)).toEqual({ port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH })
  })

  it("extracts port and path from a custom redirect URI", () => {
    expect(parseRedirectUri("http://127.0.0.1:45000/my/cb")).toEqual({ port: 45000, path: "/my/cb" })
    expect(parseRedirectUri("http://127.0.0.1:45000")).toEqual({ port: 45000, path: OAUTH_CALLBACK_PATH })
  })

  it("falls back to defaults for unparseable input", () => {
    expect(parseRedirectUri("not a url")).toEqual({ port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH })
  })
})

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

describe("auth store", () => {
  it("returns undefined / not_authenticated for a missing file", () => {
    expect(getAuthEntry("nope")).toBeUndefined()
    expect(getMcpAuthStatus("nope", "https://example.com/mcp")).toBe("not_authenticated")
    expect(authFilePath()).toBe(process.env.TRAYAMBAK_MCP_AUTH_FILE)
  })

  it("round-trips entries through the file", () => {
    setAuthEntry("srv", {
      tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 4102444800, scope: "mcp:tools" },
      clientInfo: { clientId: "c-1" },
      serverUrl: "https://example.com/mcp",
    })
    const entry = getAuthEntry("srv")
    expect(entry?.tokens?.accessToken).toBe("at-1")
    expect(entry?.clientInfo?.clientId).toBe("c-1")
    expect(entry?.serverUrl).toBe("https://example.com/mcp")
    expect(fs.existsSync(authFilePath())).toBe(true)
  })

  it("treats a corrupt file as empty and recovers on write", () => {
    fs.writeFileSync(authFile, "{definitely not json", "utf8")
    expect(getAuthEntry("srv")).toBeUndefined()
    setAuthEntry("srv", { tokens: { accessToken: "fresh" } })
    expect(getAuthEntry("srv")?.tokens?.accessToken).toBe("fresh")
  })

  it("invalidates entries recorded for a different server URL (SKT AI LABS getForUrl)", () => {
    setAuthEntry("srv", { tokens: { accessToken: "at" }, serverUrl: "https://a.example/mcp" })
    expect(getAuthEntryForUrl("srv", "https://a.example/mcp")).toBeDefined()
    expect(getAuthEntryForUrl("srv", "https://b.example/mcp")).toBeUndefined()
    expect(getMcpAuthStatus("srv", "https://b.example/mcp")).toBe("not_authenticated")
    // Raw lookup ignores the URL.
    expect(getAuthEntry("srv")).toBeDefined()
  })

  it("reports authenticated vs expired status", () => {
    const now = Math.floor(Date.now() / 1000)
    setAuthEntry("live", { tokens: { accessToken: "a", expiresAt: now + 3600 }, serverUrl: "https://x/mcp" })
    setAuthEntry("dead", { tokens: { accessToken: "a", expiresAt: now - 10 }, serverUrl: "https://x/mcp" })
    expect(getMcpAuthStatus("live", "https://x/mcp")).toBe("authenticated")
    expect(getMcpAuthStatus("dead", "https://x/mcp")).toBe("expired")
  })

  it("removes entries with removeMcpAuth", () => {
    setAuthEntry("gone", { tokens: { accessToken: "a" } })
    expect(removeMcpAuth("gone")).toBe(true)
    expect(getAuthEntry("gone")).toBeUndefined()
    expect(removeMcpAuth("gone")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("metadata discovery", () => {
  it("builds well-known candidates in RFC 8414 / MCP order", () => {
    expect(discoveryCandidates("https://ex.com/mcp")).toEqual([
      "https://ex.com/.well-known/oauth-authorization-server/mcp",
      "https://ex.com/mcp/.well-known/oauth-authorization-server",
      "https://ex.com/.well-known/oauth-authorization-server",
      "https://ex.com/.well-known/openid-configuration",
    ])
    expect(discoveryCandidates("https://ex.com/")).toEqual([
      "https://ex.com/.well-known/oauth-authorization-server",
      "https://ex.com/.well-known/openid-configuration",
    ])
  })

  it("discovers metadata at the origin root and caches it", async () => {
    const as = await startFakeAuthServer()
    const serverUrl = `${as.base}/mcp`
    const meta = await discoverOAuthMetadata(serverUrl)
    expect(meta.authorization_endpoint).toBe(as.authorizationEndpoint)
    expect(meta.token_endpoint).toBe(as.tokenEndpoint)
    expect(meta.registration_endpoint).toBe(as.registrationEndpoint)
    const discoveryHits = as.requests.filter((r) => r.url.includes(".well-known")).length
    expect(discoveryHits).toBe(3) // two 404 candidates, then the root path
    // Cached: no further requests on the second call.
    await discoverOAuthMetadata(serverUrl)
    expect(as.requests.filter((r) => r.url.includes(".well-known")).length).toBe(discoveryHits)
    await as.close()
  })

  it("throws a discovery McpAuthError when no metadata exists", async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const promise = discoverOAuthMetadata(`${srv.base}/mcp`)
    await expect(promise).rejects.toMatchObject({ name: "McpAuthError", kind: "discovery" })
    await expect(promise).rejects.toThrow(/No OAuth metadata found/)
    await srv.close()
  })
})

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

describe("dynamic client registration", () => {
  it("POSTs RFC 7591 metadata and stores the issued client", async () => {
    const as = await startFakeAuthServer()
    const metadata = clientMetadata("http://127.0.0.1:19876/mcp/oauth/callback", {})
    const info = await registerClient(as.registrationEndpoint, metadata)
    expect(info.clientId).toBe("dyn-client")
    expect(info.clientSecret).toBe("dyn-secret")
    expect(info.clientSecretExpiresAt).toBe(0)
    const body = as.registerBodies[0]
    expect(body.redirect_uris).toEqual(["http://127.0.0.1:19876/mcp/oauth/callback"])
    expect(body.client_name).toBe("trayambak")
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"])
    expect(body.response_types).toEqual(["code"])
    expect(body.token_endpoint_auth_method).toBe("none")
    await as.close()
  })

  it("throws a registration McpAuthError mentioning clientId when unsupported", async () => {
    const as = await startFakeAuthServer({ registration: false })
    await expect(
      registerClient(as.registrationEndpoint, clientMetadata("http://127.0.0.1:19876/mcp/oauth/callback", {})),
    ).rejects.toMatchObject({ name: "McpAuthError", kind: "registration" })
    await expect(
      registerClient(as.registrationEndpoint, clientMetadata("http://127.0.0.1:19876/mcp/oauth/callback", {})),
    ).rejects.toThrow(/clientId/)
    await as.close()
  })

  it("marks client_secret_post when a client secret is configured", () => {
    expect(clientMetadata("http://127.0.0.1:19876/mcp/oauth/callback", {}).token_endpoint_auth_method).toBe("none")
    expect(
      clientMetadata("http://127.0.0.1:19876/mcp/oauth/callback", { clientSecret: "s" }).token_endpoint_auth_method,
    ).toBe("client_secret_post")
  })
})

// ---------------------------------------------------------------------------
// Authorization URL + token exchange
// ---------------------------------------------------------------------------

describe("authorization URL", () => {
  it("carries all OAuth 2.1 + PKCE parameters", () => {
    const url = new URL(
      buildAuthorizationUrl("https://as.example/authorize", {
        clientId: "cid",
        redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
        state: "st4te",
        codeChallenge: "challenge",
        scope: "mcp:tools",
      }),
    )
    expect(url.origin + url.pathname).toBe("https://as.example/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("cid")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:19876/mcp/oauth/callback")
    expect(url.searchParams.get("state")).toBe("st4te")
    expect(url.searchParams.get("code_challenge")).toBe("challenge")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("scope")).toBe("mcp:tools")
  })

  it("omits scope when not configured", () => {
    const url = new URL(
      buildAuthorizationUrl("https://as.example/authorize", {
        clientId: "cid",
        redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
        state: "s",
        codeChallenge: "c",
      }),
    )
    expect(url.searchParams.has("scope")).toBe(false)
  })
})

describe("token exchange", () => {
  it("sends the authorization_code form with PKCE verifier (no secret)", async () => {
    const as = await startFakeAuthServer()
    const tokens = await exchangeAuthorizationCode(as.tokenEndpoint, {
      code: "authcode-123",
      redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
      clientId: "dyn-client",
      codeVerifier: generateCodeVerifier(),
    })
    expect(tokens.accessToken).toBe("tok-1")
    expect(tokens.refreshToken).toBe("ref-1")
    expect(tokens.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    const form = as.tokenRequests[0]
    expect(form.get("grant_type")).toBe("authorization_code")
    expect(form.get("code")).toBe("authcode-123")
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1:19876/mcp/oauth/callback")
    expect(form.get("client_id")).toBe("dyn-client")
    expect(form.get("code_verifier")!.length).toBeGreaterThanOrEqual(43)
    expect(form.has("client_secret")).toBe(false)
    await as.close()
  })

  it("includes client_secret when configured", async () => {
    const as = await startFakeAuthServer()
    await exchangeAuthorizationCode(as.tokenEndpoint, {
      code: "authcode-123",
      redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
      clientId: "confidential",
      clientSecret: "s3cret",
      codeVerifier: generateCodeVerifier(),
    })
    expect(as.tokenRequests[0].get("client_secret")).toBe("s3cret")
    await as.close()
  })

  it("surfaces token-endpoint errors as a token-kind McpAuthError", async () => {
    const as = await startFakeAuthServer()
    await expect(
      exchangeAuthorizationCode(as.tokenEndpoint, {
        code: "bad-code",
        redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
        clientId: "dyn-client",
        codeVerifier: generateCodeVerifier(),
      }),
    ).rejects.toMatchObject({ name: "McpAuthError", kind: "token" })
    await expect(
      exchangeAuthorizationCode(as.tokenEndpoint, {
        code: "bad-code",
        redirectUri: "http://127.0.0.1:19876/mcp/oauth/callback",
        clientId: "dyn-client",
        codeVerifier: generateCodeVerifier(),
      }),
    ).rejects.toThrow(/Code expired/)
    await as.close()
  })
})

// ---------------------------------------------------------------------------
// getValidAccessToken (proactive refresh)
// ---------------------------------------------------------------------------

describe("getValidAccessToken", () => {
  it("returns undefined when nothing is stored", async () => {
    expect(await getValidAccessToken("none", "https://example.com/mcp")).toBeUndefined()
  })

  it("returns a valid token without refreshing", async () => {
    const as = await startFakeAuthServer()
    const url = `${as.base}/mcp`
    setAuthEntry("ok", {
      tokens: { accessToken: "good", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      serverUrl: url,
    })
    expect(await getValidAccessToken("ok", url)).toBe("good")
    expect(as.tokenRequests.length).toBe(0)
    await as.close()
  })

  it("refreshes an expired token and persists the rotation", async () => {
    const as = await startFakeAuthServer()
    const url = `${as.base}/mcp`
    setAuthEntry("old", {
      tokens: { accessToken: "stale", refreshToken: "ref-old", expiresAt: Math.floor(Date.now() / 1000) - 10 },
      clientInfo: { clientId: "stored-client" },
      serverUrl: url,
    })
    expect(await getValidAccessToken("old", url)).toBe("tok-refresh")
    const form = as.tokenRequests[0]
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe("ref-old")
    expect(form.get("client_id")).toBe("stored-client")
    const entry = getAuthEntry("old")
    expect(entry?.tokens?.accessToken).toBe("tok-refresh")
    expect(entry?.tokens?.refreshToken).toBe("ref-new")
    expect(entry?.tokens?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    await as.close()
  })

  it("returns the stale token when no refresh token exists", async () => {
    const as = await startFakeAuthServer()
    const url = `${as.base}/mcp`
    setAuthEntry("noref", {
      tokens: { accessToken: "old", expiresAt: Math.floor(Date.now() / 1000) - 100 },
      serverUrl: url,
    })
    expect(await getValidAccessToken("noref", url)).toBe("old")
    expect(as.tokenRequests.length).toBe(0)
    await as.close()
  })

  it("ignores tokens stored for a different server URL", async () => {
    const as = await startFakeAuthServer()
    setAuthEntry("other", { tokens: { accessToken: "at" }, serverUrl: "https://elsewhere.example/mcp" })
    expect(await getValidAccessToken("other", `${as.base}/mcp`)).toBeUndefined()
    await as.close()
  })
})

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

describe("OAuth callback server", () => {
  it("binds the default endpoint, resolves the code, serves success HTML, and stops when idle", async () => {
    const cb = await ensureRunning()
    expect(cb.port).toBeGreaterThanOrEqual(OAUTH_CALLBACK_PORT)
    expect(cb.port).toBeLessThan(OAUTH_CALLBACK_PORT + 5)
    expect(cb.path).toBe(OAUTH_CALLBACK_PATH)
    expect(cb.redirectUri).toBe(`http://127.0.0.1:${cb.port}${cb.path}`)

    const pending = waitForCallback("state-1", "srv", 10_000)
    const res = await fetch(`${cb.redirectUri}?code=the-code&state=state-1`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("Authorization Successful")
    expect(await pending).toBe("the-code")

    // No pending flows -> the server shuts itself down (SKT AI LABS stopIfIdle).
    expect(isRunning()).toBe(false)
  })

  it("rejects callbacks without a state parameter (CSRF) but keeps the flow pending", async () => {
    const cb = await ensureRunning()
    const pending = waitForCallback("state-m", undefined, 10_000)
    const res = await fetch(`${cb.redirectUri}?code=x`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("state")
    // Flow untouched: the correct state still resolves it.
    const res2 = await fetch(`${cb.redirectUri}?code=x&state=state-m`)
    expect(res2.status).toBe(200)
    expect(await pending).toBe("x")
  })

  it("rejects unknown state parameters", async () => {
    const cb = await ensureRunning()
    const pending = waitForCallback("state-u", undefined, 10_000)
    const res = await fetch(`${cb.redirectUri}?code=x&state=WRONG`)
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("Invalid or expired state")
    const res2 = await fetch(`${cb.redirectUri}?code=ok&state=state-u`)
    expect(res2.status).toBe(200)
    expect(await pending).toBe("ok")
  })

  it("forwards authorization errors to the pending flow", async () => {
    const cb = await ensureRunning()
    const pending = waitForCallback("state-e", undefined, 10_000)
    // Attach the rejection handler BEFORE triggering the error response, so
    // Node never observes an unhandled-rejection window while we read the body.
    const captured = pending.then(
      () => undefined,
      (e: unknown) => e,
    )
    const res = await fetch(
      `${cb.redirectUri}?error=access_denied&error_description=User+denied+the+request&state=state-e`,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("Authorization Failed")
    const err = await captured
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/User denied the request/)
  })

  it("times out pending flows", async () => {
    await ensureRunning()
    await expect(waitForCallback("state-t", undefined, 50)).rejects.toThrow(/timeout/)
  })

  it("404s requests on the wrong path", async () => {
    const cb = await ensureRunning()
    const pending = waitForCallback("state-p", undefined, 10_000)
    const res = await fetch(`http://127.0.0.1:${cb.port}/totally/wrong?code=x&state=state-p`)
    expect(res.status).toBe(404)
    const res2 = await fetch(`${cb.redirectUri}?code=x&state=state-p`)
    expect(res2.status).toBe(200)
    expect(await pending).toBe("x")
  })

  it("binds an explicit custom redirect URI exactly and reuses it", async () => {
    const port = await freePort()
    const custom = `http://127.0.0.1:${port}/custom/cb`
    const cb1 = await ensureRunning(custom)
    expect(cb1.redirectUri).toBe(custom)
    expect(cb1.port).toBe(port)
    expect(cb1.path).toBe("/custom/cb")

    const pending = waitForCallback("state-c", undefined, 10_000)
    const res = await fetch(`${custom}?code=c-code&state=state-c`)
    expect(res.status).toBe(200)
    expect(await pending).toBe("c-code")
    // Resolved -> idle -> stopped; a second ensure with the same URI rebinds cleanly.
    const cb2 = await ensureRunning(custom)
    expect(cb2.redirectUri).toBe(custom)
  })

  it("falls back to the next port when the default is occupied", async () => {
    const blocker = http.createServer((_req, res) => res.end())
    const occupied = await new Promise<boolean>((resolve) => {
      blocker.once("error", () => resolve(false))
      blocker.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve(true))
    })
    if (!occupied) {
      // Port taken by a foreign process; fallback behavior can't be isolated here.
      blocker.close()
      return
    }
    try {
      const cb = await ensureRunning()
      expect(cb.port).not.toBe(OAUTH_CALLBACK_PORT)
      expect(cb.port).toBeLessThan(OAUTH_CALLBACK_PORT + 5)
      expect(cb.path).toBe(OAUTH_CALLBACK_PATH)
    } finally {
      await stop()
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })

  it("fails clearly when an explicit redirect port is occupied", async () => {
    const blocker = http.createServer((_req, res) => res.end())
    const port = await freePort()
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()))
    try {
      await expect(ensureRunning(`http://127.0.0.1:${port}/cb`)).rejects.toThrow(/already in use/)
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })
})

// ---------------------------------------------------------------------------
// Full interactive authorization flow
// ---------------------------------------------------------------------------

describe("authorizeMcpServer", () => {
  it("runs the full PKCE flow: register -> browser -> callback -> exchange -> store", async () => {
    const as = await startFakeAuthServer()
    const serverUrl = `${as.base}/mcp`
    const notices: string[] = []
    const opened: string[] = []

    const ok = await authorizeMcpServer(
      "flow",
      serverUrl,
      {},
      {
        open: async (authUrl) => {
          opened.push(authUrl)
          await fetch(authUrl) // follows the 302 straight to our loopback callback
          return true
        },
        onNotice: (m) => notices.push(m),
      },
    )
    expect(ok).toBe(true)

    // The browser got a well-formed authorization URL carrying PKCE + CSRF state.
    expect(opened).toHaveLength(1)
    const authUrl = new URL(opened[0])
    expect(authUrl.searchParams.get("client_id")).toBe("dyn-client")
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/)
    const redirectUri = authUrl.searchParams.get("redirect_uri")
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/oauth\/callback$/)
    expect(notices.join("\n")).toContain(opened[0])

    // Dynamic registration happened exactly once, for the effective redirect URI.
    expect(as.registerBodies).toHaveLength(1)
    expect(as.registerBodies[0].redirect_uris).toEqual([redirectUri])

    // The exchange used the same code_verifier whose S256 hash was advertised.
    const tokenForm = as.tokenRequests[0]
    expect(tokenForm.get("grant_type")).toBe("authorization_code")
    expect(tokenForm.get("code")).toBe("authcode-123")
    expect(computeCodeChallenge(tokenForm.get("code_verifier")!)).toBe(authUrl.searchParams.get("code_challenge"))

    // Tokens + client info persisted with the SKT AI LABS-parity entry shape.
    const entry = getAuthEntry("flow")
    expect(entry?.tokens?.accessToken).toBe("tok-1")
    expect(entry?.tokens?.refreshToken).toBe("ref-1")
    expect(entry?.clientInfo?.clientId).toBe("dyn-client")
    expect(entry?.serverUrl).toBe(serverUrl)
    expect(getMcpAuthStatus("flow", serverUrl)).toBe("authenticated")
    await as.close()
  })

  it("uses a configured clientId without registering (and skips persisting clientInfo)", async () => {
    const as = await startFakeAuthServer()
    const serverUrl = `${as.base}/mcp`
    const opened: string[] = []

    await authorizeMcpServer(
      "cfgcli",
      serverUrl,
      { clientId: "cfg-client" },
      {
        open: async (authUrl) => {
          opened.push(authUrl)
          await fetch(authUrl)
          return true
        },
        onNotice: () => {},
      },
    )

    expect(as.registerBodies).toHaveLength(0)
    expect(new URL(opened[0]).searchParams.get("client_id")).toBe("cfg-client")
    expect(as.tokenRequests[0].get("client_id")).toBe("cfg-client")
    const entry = getAuthEntry("cfgcli")
    expect(entry?.tokens?.accessToken).toBe("tok-1")
    expect(entry?.clientInfo).toBeUndefined()
    await as.close()
  })

  it("fails with a registration error when the server cannot register clients", async () => {
    const as = await startFakeAuthServer({ registration: false })
    const flow1 = authorizeMcpServer("noreg", `${as.base}/mcp`, {}, { open: () => true, onNotice: () => {} })
    await expect(flow1).rejects.toMatchObject({ name: "McpAuthError", kind: "registration" })
    const flow2 = authorizeMcpServer("noreg", `${as.base}/mcp`, {}, { open: () => true, onNotice: () => {} })
    await expect(flow2).rejects.toThrow(/clientId/)
    await as.close()
  })

  it("times out the callback and wraps it as a callback-kind error", async () => {
    const as = await startFakeAuthServer()
    const flow = authorizeMcpServer(
      "slow",
      `${as.base}/mcp`,
      {},
      {
        open: () => true, // browser "opened" but the user never approves
        onNotice: () => {},
        waitMs: 150,
      },
    )
    await expect(flow).rejects.toMatchObject({ name: "McpAuthError", kind: "callback" })
    await expect(flow).rejects.toThrow(/timeout/)
    await as.close()
  })

  it("deduplicates concurrent flows for the same server", async () => {
    const as = await startFakeAuthServer()
    const serverUrl = `${as.base}/mcp`
    const opts = {
      open: async (authUrl: string) => {
        await fetch(authUrl)
        return true
      },
      onNotice: () => {},
    }
    const p1 = authorizeMcpServer("dedupe", serverUrl, {}, opts)
    const p2 = authorizeMcpServer("dedupe", serverUrl, {}, opts)
    expect(p1).toBe(p2)
    await p1
    expect(as.registerBodies).toHaveLength(1)
    expect(as.tokenRequests).toHaveLength(1)
    await as.close()
  })
})

// ---------------------------------------------------------------------------
// Connection integration (bearer token, static headers, 401 handling)
// ---------------------------------------------------------------------------

describe("McpConnection auth integration", () => {
  it("attaches the stored bearer token to every HTTP request", async () => {
    const srv = await startMcpLikeServer({ auth: "tok-ok" })
    const url = `${srv.base}/mcp`
    setAuthEntry("secure", {
      tokens: { accessToken: "tok-ok", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      serverUrl: url,
    })
    const conn = createMcpConnection("secure", { url })
    try {
      const tools = await conn.listTools(0)
      expect(tools.map((t) => t.name)).toEqual(["echo"])
      expect(srv.requests.length).toBeGreaterThanOrEqual(2) // initialize + tools/list
      for (const r of srv.requests) expect(r.headers.authorization).toBe("Bearer tok-ok")
    } finally {
      conn.close()
      await srv.close()
    }
  })

  it("sends static spec.headers and skips the token lookup when oauth is off", async () => {
    const srv = await startMcpLikeServer({})
    const conn = createMcpConnection("hdr", {
      url: `${srv.base}/mcp`,
      headers: { "X-Api-Key": "k-123" },
      oauth: false,
    })
    try {
      await conn.connect()
      expect(srv.requests[0].headers["x-api-key"]).toBe("k-123")
      expect(srv.requests[0].headers.authorization).toBeUndefined()
    } finally {
      conn.close()
      await srv.close()
    }
  })

  it("preserves query strings in the request path", async () => {
    const srv = await startMcpLikeServer({})
    const conn = createMcpConnection("q", { url: `${srv.base}/mcp?api-key=abc`, oauth: false })
    try {
      await conn.connect()
      expect(srv.requests[0].url).toBe("/mcp?api-key=abc")
    } finally {
      conn.close()
      await srv.close()
    }
  })

  it("turns a headless 401 into actionable guidance instead of blocking for a browser", async () => {
    const srv = await startMcpLikeServer({ auth: "required" })
    const conn = createMcpConnection("gate401", { url: `${srv.base}/mcp` })
    const restoreTty = forceNonTty()
    try {
      const err = await conn.listTools(0).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(McpAuthError)
      const authErr = err as McpAuthError
      expect(authErr.kind).toBe("auth-required")
      expect(authErr.message).toMatch(/HTTP 401/)
      expect(authErr.message).toMatch(/trayambak mcp auth gate401/)
    } finally {
      restoreTty()
      conn.close()
      await srv.close()
    }
  })

  it("passes a raw 401 through untouched when oauth is disabled", async () => {
    const srv = await startMcpLikeServer({ auth: "required" })
    const conn = createMcpConnection("off401", { url: `${srv.base}/mcp`, oauth: false })
    try {
      const err = await conn.listTools(0).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(McpAuthError)
      const message = (err as Error).message
      expect(message).toMatch(/HTTP 401/)
      expect(message).not.toMatch(/trayambak mcp auth/)
    } finally {
      conn.close()
      await srv.close()
    }
  })

  it("surfaces non-auth HTTP failures with the status code", async () => {
    const srv = await startMcpLikeServer({ status500: true })
    const conn = createMcpConnection("srv500", { url: `${srv.base}/mcp`, oauth: false })
    try {
      await expect(conn.listTools(0)).rejects.toThrow(/HTTP 500/)
    } finally {
      conn.close()
      await srv.close()
    }
  })
})
