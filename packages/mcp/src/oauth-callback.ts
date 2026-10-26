/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Localhost OAuth 2.0 redirect-callback server for remote MCP servers.
 * Ported from Shrijan Code's `mcp/oauth-callback.ts` design: a loopback HTTP
 * server on 127.0.0.1 that receives the authorization-server redirect,
 * validates the `state` parameter (CSRF), resolves the pending flow with the
 * authorization code, renders a success/error page, and stops itself once no
 * flows are pending.
 */

import * as http from "http"
import * as net from "net"

/** Default loopback port the authorization server redirects back to. */
export const OAUTH_CALLBACK_PORT = 19876
/** Default callback path (must be pre-registered with the authorization server). */
export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"
/** How long we wait for the user to approve in the browser (Shrijan parity: 5 min). */
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
/** How many consecutive default ports to try before giving up. */
const DEFAULT_PORT_FALLBACKS = 5

/** Resolve a configured redirect URI into the port/path the callback server must bind. */
export function parseRedirectUri(redirectUri?: string): { port: number; path: string } {
  if (!redirectUri) {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
  try {
    const parsed = new URL(redirectUri)
    const port = parsed.port ? parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80
    const callbackPath = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : OAUTH_CALLBACK_PATH
    return { port, path: callbackPath }
  } catch {
    return { port: OAUTH_CALLBACK_PORT, path: OAUTH_CALLBACK_PATH }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Nemo - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Nemo.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

const HTML_ERROR = (error: string): string => `<!DOCTYPE html>
<html>
<head>
  <title>Nemo - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .detail { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <pre class="detail">${escapeHtml(error)}</pre>
  </div>
</body>
</html>`

interface PendingAuth {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

let server: http.Server | undefined
let currentPort = OAUTH_CALLBACK_PORT
let currentPath = OAUTH_CALLBACK_PATH
const pendingAuths = new Map<string, PendingAuth>()
// Reverse index: mcpName -> oauthState so cancelPending(name) can find the
// entry in pendingAuths (which is keyed by the state parameter).
const mcpNameToState = new Map<string, string>()

function cleanupStateIndex(oauthState: string): void {
  for (const [name, state] of mcpNameToState) {
    if (state === oauthState) {
      mcpNameToState.delete(name)
      break
    }
  }
}

function stopIfIdle(): void {
  if (pendingAuths.size > 0 || !server) return
  const instance = server
  server = undefined
  instance.close()
  // Force-close lingering keep-alive sockets (browser/fetch agents) once the
  // success response has flushed, so the port is immediately rebindable.
  setImmediate(() => {
    ;(instance as http.Server & { closeIdleConnections?: () => void }).closeIdleConnections?.()
  })
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${currentPort}`)

  if (requestUrl.pathname !== currentPath) {
    res.writeHead(404)
    res.end("Not found")
    return
  }

  const code = requestUrl.searchParams.get("code")
  const state = requestUrl.searchParams.get("state")
  const error = requestUrl.searchParams.get("error")
  const errorDescription = requestUrl.searchParams.get("error_description")

  // Enforce state parameter presence (CSRF protection).
  if (!state) {
    const errorMsg = "Missing required state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  if (error) {
    const errorMsg = errorDescription || error
    const pending = pendingAuths.get(state)
    if (pending) {
      clearTimeout(pending.timeout)
      pendingAuths.delete(state)
      cleanupStateIndex(state)
      pending.reject(new Error(errorMsg))
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR(errorMsg))
    stopIfIdle()
    return
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR("No authorization code provided"))
    return
  }

  if (!pendingAuths.has(state)) {
    const errorMsg = "Invalid or expired state parameter - potential CSRF attack"
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
    res.end(HTML_ERROR(errorMsg))
    return
  }

  const pending = pendingAuths.get(state)!
  clearTimeout(pending.timeout)
  pendingAuths.delete(state)
  cleanupStateIndex(state)
  pending.resolve(code)

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(HTML_SUCCESS)
  stopIfIdle()
}

/** Check whether something is already listening on the given loopback port. */
export function isPortInUse(port: number = OAUTH_CALLBACK_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(/*value*/ true)
    })
    socket.on("error", () => {
      resolve(/*value*/ false)
    })
  })
}

/** Bind a fresh callback server on 127.0.0.1:port for the given path. */
function listen(port: number, callbackPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const instance = http.createServer(handleRequest)
    const onError = (): void => {
      // Listen failed (e.g. EADDRINUSE) - the handle was never opened, so just
      // drop the listeners and report "not bound" for port-fallback attempts.
      instance.removeListener("listening", onListening)
      resolve(/*value*/ false)
    }
    const onListening = (): void => {
      instance.removeListener("error", onError)
      instance.on("error", () => {
        /* late socket errors must not crash the flow */
      })
      server = instance
      currentPort = port
      currentPath = callbackPath
      resolve(/*value*/ true)
    }
    instance.once("error", onError)
    instance.once("listening", onListening)
    instance.listen(port, "127.0.0.1")
  })
}

/**
 * Ensure the callback server is running and return the effective redirect URI.
 * When `redirectUri` is given, that exact port/path is bound (it must match
 * what was registered with the authorization server). Otherwise the default
 * port is tried first, then a few fallbacks, and the *actual* bound URI is
 * returned so the authorization URL can be built from it.
 */
export async function ensureRunning(redirectUri?: string): Promise<{
  redirectUri: string
  port: number
  path: string
}> {
  const want = parseRedirectUri(redirectUri)

  if (server) {
    const reuse = redirectUri
      ? currentPort === want.port && currentPath === want.path
      : currentPath === OAUTH_CALLBACK_PATH
    if (reuse) {
      return { redirectUri: `http://127.0.0.1:${currentPort}${currentPath}`, port: currentPort, path: currentPath }
    }
    await stop()
  }

  if (redirectUri) {
    const bound = await listen(want.port, want.path)
    if (!bound) {
      throw new Error(
        `OAuth callback port ${want.port} is already in use. Free it or set a different callbackPort/redirectUri.`,
      )
    }
  } else {
    let bound = false
    for (let port = OAUTH_CALLBACK_PORT; port < OAUTH_CALLBACK_PORT + DEFAULT_PORT_FALLBACKS && !bound; port++) {
      bound = await listen(port, OAUTH_CALLBACK_PATH)
    }
    if (!bound) {
      throw new Error(
        `Could not bind an OAuth callback port (tried ${OAUTH_CALLBACK_PORT}-${OAUTH_CALLBACK_PORT + DEFAULT_PORT_FALLBACKS - 1} on 127.0.0.1).`,
      )
    }
  }

  return { redirectUri: `http://127.0.0.1:${currentPort}${currentPath}`, port: currentPort, path: currentPath }
}

/**
 * Wait for the authorization server to redirect back with a code for the
 * given `state`. Rejects on timeout (default 5 minutes).
 */
export function waitForCallback(
  oauthState: string,
  mcpName?: string,
  timeoutMs: number = OAUTH_CALLBACK_TIMEOUT_MS,
): Promise<string> {
  if (mcpName) mcpNameToState.set(mcpName, oauthState)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingAuths.has(oauthState)) {
        pendingAuths.delete(oauthState)
        if (mcpName) mcpNameToState.delete(mcpName)
        reject(new Error("OAuth callback timeout - authorization took too long"))
        stopIfIdle()
      }
    }, timeoutMs)
    pendingAuths.set(oauthState, { resolve, reject, timeout })
  })
}

/** Cancel a pending flow by MCP server name (used by `mcp logout`). */
export function cancelPending(mcpName: string): void {
  const oauthState = mcpNameToState.get(mcpName)
  const key = oauthState ?? mcpName
  const pending = pendingAuths.get(key)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingAuths.delete(key)
    mcpNameToState.delete(mcpName)
    pending.reject(new Error("Authorization cancelled"))
    stopIfIdle()
  }
}

/** Stop the callback server and reject any pending flows. */
export async function stop(): Promise<void> {
  if (server) {
    const instance = server
    server = undefined
    // Destroy keep-alive sockets first, otherwise close()'s callback waits for
    // them to time out and the next bind hits EADDRINUSE.
    ;(instance as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.()
    await new Promise<void>((resolve) => instance.close(() => resolve()))
  }
  for (const [, pending] of pendingAuths) {
    clearTimeout(pending.timeout)
    pending.reject(new Error("OAuth callback server stopped"))
  }
  pendingAuths.clear()
  mcpNameToState.clear()
}

export function isRunning(): boolean {
  return server !== undefined
}
