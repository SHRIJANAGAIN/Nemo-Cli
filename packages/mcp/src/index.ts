/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { spawn, type ChildProcess } from "child_process"
import * as http from "http"
import * as https from "https"
import * as readline from "readline"
import * as url from "url"
import { McpAuthError, authorizeMcpServer, getValidAccessToken, type McpOAuthConfig } from "./oauth.js"
import { resolveMcpCommand } from "./spawn-resolve.js"
import { getSafeEnv } from "../../../packages/core/src/env_filter.js"

/** Transport spec for one MCP server: either stdio (`command`+`args`) or HTTP (`url`). */
export interface McpServerSpec {
  command?: string[]
  url?: string
  env?: Record<string, string>
  timeoutMs?: number
  cwd?: string
  /** Extra HTTP headers sent with every request (e.g. static API keys). */
  headers?: Record<string, string>
  /** OAuth 2.0 + PKCE for remote (`url`) servers. `false` disables it, an object
   *  tunes clientId/clientSecret/scope/callbackPort/redirectUri, `undefined` = on. */
  oauth?: boolean | McpOAuthConfig
}

/**
 * Environment for a spawned stdio server (#62): secret-bearing process env
 * vars (provider API keys et al.) never reach the child — same filtering as
 * every other spawn in the repo (hook-exec, mcp-runner, MCP-server bash) —
 * while `spec.env` (config-declared) still wins for the server's own needs.
 */
export function mcpChildEnv(spec: Pick<McpServerSpec, "env">): Record<string, string> {
  return { ...getSafeEnv(process.env), ...(spec.env ?? {}) }
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
  isError?: boolean
}

export interface McpResourceInfo {
  uri: string
  name: string
  mimeType?: string
  description?: string
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpPromptMessage {
  role: "user" | "assistant" | "system"
  /** Plain text or raw spec content blocks (kept verbatim for fidelity). */
  content: string | unknown[]
}

export interface McpPrompt {
  name: string
  messages: McpPromptMessage[]
}

export interface McpHealthStatus {
  name: string
  connected: boolean
  transport: "stdio" | "http" | "disconnected"
  initialized: boolean
  lastRequestAt?: number
  lastError?: string
}

export interface McpStructuredError {
  code: number
  message: string
  data?: unknown
}

export class McpError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Minimal MCP (Model Context Protocol) client. Implements the JSON-RPC 2.0
 * core of the protocol - `initialize`, `tools/list`, `tools/call`, and
 * `resources/list`, `resources/read`, `prompts/list`, `prompts/get` - over
 * stdio (spawned subprocess) or a simple HTTP POST transport. This mirrors the
 * shape used by the reference agent projects in `tool/` (cline, SKT AI LABS,
 * trayambak) so existing MCP servers are drop-in compatible.
 */
export class McpConnection {
  readonly name: string
  readonly spec: McpServerSpec
  private child: ChildProcess | null = null
  private rl: readline.Interface | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private initialized = false
  private lastRequestAt: number = 0
  private lastError: string = ""
  private cachedTools: McpToolInfo[] | null = null
  private cachedToolsAt: number = 0
  private cacheTtlMs: number = 300_000
  private reconnecting = false
  /** True once an OAuth flow was attempted on this connection (prevents retry loops). */
  private authAttempted = false

  constructor(name: string, spec: McpServerSpec) {
    this.name = name
    this.spec = spec
  }

  private get timeoutMs(): number {
    return this.spec.timeoutMs ?? 60_000
  }

  /** OAuth applies to remote servers unless explicitly disabled with `oauth: false`. */
  private get oauthEnabled(): boolean {
    return Boolean(this.spec.url) && this.spec.oauth !== false
  }

  private get oauthConfig(): McpOAuthConfig {
    return typeof this.spec.oauth === "object" && this.spec.oauth !== null ? this.spec.oauth : {}
  }

  /** Open the transport and run MCP `initialize`. Safe to call multiple times. */
  async connect(): Promise<void> {
    if (this.initialized) return
    if (this.reconnecting) {
      // Bounded wait: an unwatched reconnect must never park callers forever.
      const start = Date.now()
      await new Promise<void>((resolve, reject) => {
        const check = setInterval(() => {
          if (!this.reconnecting || Date.now() - start > 30_000) {
            clearInterval(check)
            if (this.reconnecting) reject(new Error(`MCP ${this.name}: reconnect timed out`))
            else resolve()
          }
        }, 50)
      })
      return
    }
    const init = {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "trayambak", version: "0.3.0" },
    }
    if (this.spec.url) {
      await this.request("initialize", init)
    } else {
      this.spawnStdio()
      await this.request("initialize", init)
    }
    // Spec-required handshake step: strict servers ignore every call until
    // they see it (this was the google-drive "timeout on 'initialize'").
    await this.notify("notifications/initialized", {})
    this.initialized = true
  }

  /** Fire-and-forget JSON-RPC notification (no id, no response). */
  private notify(method: string, params: unknown): Promise<void> {
    this.lastRequestAt = Date.now()
    if (this.spec.url) {
      return this.postNotificationHttp(method, params)
    }
    if (!this.child) return Promise.resolve()
    try {
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
    } catch {
      /* best effort */
    }
    return Promise.resolve()
  }

  /** Bearer + static headers shared by every HTTP call (a missing token on
   *  ANY call, including notifications, breaks auth-strict servers). */
  private async httpHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...(this.spec.headers ?? {}) }
    if (this.oauthEnabled) {
      try {
        const token = await getValidAccessToken(this.name, this.spec.url!, this.oauthConfig)
        if (token) headers["Authorization"] = `Bearer ${token}`
      } catch (err) {
        // Leave the request unauthenticated (a 401 triggers the full flow
        // below), but keep the cause visible instead of swallowing it.
        this.lastError = `token lookup failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    return headers
  }

  private async postNotificationHttp(method: string, params: unknown): Promise<void> {
    const base = new url.URL(this.spec.url!)
    const lib = base.protocol === "https:" ? https : http
    const data = JSON.stringify({ jsonrpc: "2.0", method, params })
    const extra = await this.httpHeaders()
    return new Promise<void>((resolve) => {
      const req = lib.request(
        {
          hostname: base.hostname,
          port: base.port || (base.protocol === "https:" ? 443 : 80),
          path: base.pathname + base.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Content-Length": String(Buffer.byteLength(data)),
            ...extra,
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          res.resume()
          res.on("end", () => resolve())
        },
      )
      req.on("error", () => resolve())
      req.on("timeout", () => {
        req.destroy()
        resolve()
      })
      req.end(data)
    })
  }

  /** Returns connection health and status information. */
  async status(): Promise<McpHealthStatus> {
    // A dead stdio child must not report connected:true (checked liveness,
    // not just handle presence).
    const stdioAlive = this.child !== null && this.child.exitCode === null && !this.child.killed
    const connected = stdioAlive || this.spec.url !== undefined
    let transport: "stdio" | "http" | "disconnected" = "disconnected"
    if (connected) {
      transport = this.spec.url ? "http" : "stdio"
    }
    const result: McpHealthStatus = {
      name: this.name,
      connected,
      transport,
      initialized: this.initialized,
      lastRequestAt: this.lastRequestAt > 0 ? this.lastRequestAt : undefined,
      lastError: this.lastError || undefined,
    }
    if (connected && this.spec.url) {
      try {
        await this.request("tools/list", {})
        result.connected = true
      } catch (err) {
        result.connected = false
        result.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return result
  }

  /** Reconnect: close the transport and re-initialize. Useful after transport failure. */
  async reconnect(): Promise<void> {
    this.reconnecting = true
    this.close()
    this.initialized = false
    this.cachedTools = null
    this.cachedToolsAt = 0
    this.lastError = ""
    try {
      await this.connect()
    } finally {
      this.reconnecting = false
    }
  }

  /** List MCP tools, using cached results when available and within TTL. */
  async listTools(cacheTtlMs?: number): Promise<McpToolInfo[]> {
    await this.connect()
    const ttl = cacheTtlMs ?? this.cacheTtlMs
    const now = Date.now()
    if (this.cachedTools !== null && now - this.cachedToolsAt < ttl) {
      return this.cachedTools
    }
    // Cursor pagination (bounded): large servers truncate to one page otherwise.
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpToolInfo[]
        nextCursor?: string
      }
      tools.push(...(result?.tools ?? []))
      cursor = result?.nextCursor
      if (!cursor) break
    }
    this.cachedTools = tools
    this.cachedToolsAt = now
    return tools
  }

  /** List available resources from the MCP server. */
  async listResources(): Promise<McpResourceInfo[]> {
    await this.connect()
    try {
      const out: McpResourceInfo[] = []
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const result = (await this.request("resources/list", cursor ? { cursor } : {})) as {
          resources?: McpResourceInfo[]
          nextCursor?: string
        }
        out.push(...(result?.resources ?? []))
        cursor = result?.nextCursor
        if (!cursor) break
      }
      return out
    } catch (err) {
      if (err instanceof McpError && err.code === -32601) {
        return []
      }
      throw err
    }
  }

  /** Read the content of a resource by URI. */
  async readResource(uri: string): Promise<string> {
    await this.connect()
    try {
      const result = (await this.request("resources/read", { uri })) as {
        contents?: Array<{ text?: string; blob?: string; mimeType?: string }>
      }
      if (result?.contents) {
        return result.contents
          .map((c) =>
            typeof c.text === "string"
              ? c.text
              : typeof c.blob === "string"
                ? `[binary ${c.mimeType ?? "blob"} ${(c.blob ?? "").length} chars base64]`
                : JSON.stringify(c),
          )
          .join("\n")
      }
      return ""
    } catch (err) {
      if (err instanceof McpError && err.code === -32601) {
        return ""
      }
      throw err
    }
  }

  /** List available prompts from the MCP server. */
  async listPrompts(): Promise<McpPromptInfo[]> {
    await this.connect()
    try {
      const out: McpPromptInfo[] = []
      let cursor: string | undefined
      for (let page = 0; page < 50; page++) {
        const result = (await this.request("prompts/list", cursor ? { cursor } : {})) as {
          prompts?: McpPromptInfo[]
          nextCursor?: string
        }
        out.push(...(result?.prompts ?? []))
        cursor = result?.nextCursor
        if (!cursor) break
      }
      return out
    } catch (err) {
      if (err instanceof McpError && err.code === -32601) {
        return []
      }
      throw err
    }
  }

  /** Get a prompt by name with optional arguments. */
  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPrompt | null> {
    await this.connect()
    try {
      // Spec shape is flat ({messages, description?}); tolerate a wrapped variant too.
      const result = (await this.request("prompts/get", { name, arguments: args ?? {} })) as {
        messages?: McpPromptMessage[]
        description?: string
        prompt?: { messages?: McpPromptMessage[] }
      }
      const messages = result?.messages ?? result?.prompt?.messages
      if (!messages) return null
      return { name, messages }
    } catch (err) {
      if (err instanceof McpError && err.code === -32601) {
        return null
      }
      throw err
    }
  }

  /** Invoke an MCP tool by name with the given arguments. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.connect()
    return (await this.request("tools/call", { name, arguments: args })) as McpToolResult
  }

  /** Close the transport. Safe to call multiple times. */
  close(): void {
    const child = this.child
    this.child = null
    this.rl?.close()
    this.rl = null
    this.initialized = false
    this.cachedTools = null
    this.authAttempted = false
    this.rejectAll(new Error(`MCP ${this.name} connection closed`))
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM")
      // Best-effort reaper: SIGTERM-ignoring servers must not linger as zombies.
      const killer = setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }, 2000)
      if (typeof killer.unref === "function") killer.unref()
    }
  }

  private stderrTail: string[] = []

  private spawnStdio(): void {
    const spec = this.spec
    const raw: string[] = spec.command ?? []
    if (raw.length === 0) throw new Error(`MCP server '${this.name}' has no command or url`)
    // Never spawn bare shims (npx/node/python): GUI-launched shells hit
    // ENOENT, and *.cmd shims throw EINVAL — resolve first instead.
    const { command: cmd, args } = resolveMcpCommand(raw)
    this.stderrTail = []
    this.child = spawn(cmd, args, {
      cwd: spec.cwd,
      env: mcpChildEnv(spec),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    // Bounded stderr capture (last 20 lines): silent servers used to leave
    // zero diagnostics on timeout/exit ("timeout on 'initialize'" with no why).
    this.child.stderr?.on("data", (c: Buffer | string) => {
      for (const line of String(c).split("\n")) {
        const t = line.trimEnd()
        if (!t) continue
        this.stderrTail.push(t.slice(-500))
        if (this.stderrTail.length > 20) this.stderrTail.shift()
      }
    })
    this.rl = readline.createInterface({ input: this.child.stdout! })
    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line) as { id?: number }
        if (msg.id === undefined) return
        const waiter = this.pending.get(msg.id)
        if (!waiter) return
        this.pending.delete(msg.id)
        const resp = msg as JsonRpcResponse
        if (resp.error) {
          const mcpErr = new McpError(resp.error.code, resp.error.message, resp.error.data)
          waiter.reject(mcpErr)
        } else {
          waiter.resolve(resp.result)
        }
      } catch {
        /* not JSON - skip */
      }
    })
    this.child.on("error", (err) => {
      this.lastError = err.message
      this.rejectAll(new Error(`MCP ${this.name} process error: ${err.message}`))
    })
    this.child.on("exit", (code) => {
      // Any exit (even 0) invalidates the transport: stale handle + cache
      // used to report connected:true and hang later calls on timeout.
      const tail = this.stderrTail.length > 0 ? ` Server stderr: ${this.stderrTail.join(" | ").slice(0, 500)}` : ""
      this.lastError = `exited with code ${code ?? "signal"}.${tail}`
      this.child = null
      this.initialized = false
      this.cachedTools = null
      this.rejectAll(new Error(`MCP ${this.name} exited with code ${code ?? "signal"}.${tail}`))
    })
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    this.lastRequestAt = Date.now()
    this.lastError = ""
    if (!this.spec.url) {
      if (!this.child) throw new Error(`MCP '${this.name}' is not connected`)
      return this.requestStdio(method, params)
    }
    try {
      return await this.requestHttp(method, params)
    } catch (err) {
      if (!(err instanceof McpAuthError) || !this.oauthEnabled || this.authAttempted) throw err
      this.authAttempted = true
      if (!process.stdin.isTTY) {
        // Headless (tests/CI/daemon): never block for a browser - tell the user how to auth.
        throw new McpAuthError(
          `${err.message} Run \`trayambak mcp auth ${this.name}\` to authorize interactively.`,
          "auth-required",
        )
      }
      // Interactive: run discovery + PKCE + callback flow, then retry exactly once.
      await authorizeMcpServer(this.name, this.spec.url, this.oauthConfig)
      return await this.requestHttp(method, params)
    }
  }

  private requestStdio(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const tail = this.stderrTail.length > 0 ? ` Server stderr: ${this.stderrTail.join(" | ").slice(0, 500)}` : ""
        this.lastError = `timeout on '${method}'.${tail}`
        reject(new Error(`MCP ${this.name}: timeout on '${method}'.${tail}`))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          this.lastError = ""
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          this.lastError = e.message
          reject(e)
        },
      })
      const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
      this.child!.stdin!.write(JSON.stringify(payload) + "\n")
    })
  }

  private async requestHttp(method: string, params: unknown): Promise<unknown> {
    const base = new url.URL(this.spec.url!)
    const lib = base.protocol === "https:" ? https : http
    const id = this.nextId++
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
    const data = JSON.stringify(payload)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": String(Buffer.byteLength(data)),
      ...(await this.httpHeaders()),
    }
    return new Promise<unknown>((resolve, reject) => {
      const req = lib.request(
        {
          hostname: base.hostname,
          port: base.port || (base.protocol === "https:" ? 443 : 80),
          path: base.pathname + base.search,
          method: "POST",
          headers,
          timeout: this.timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0
          let buf = ""
          res.setEncoding("utf8")
          res.on("data", (c: string) => (buf += c))
          res.on("end", () => {
            if (status === 401) {
              this.lastError = "HTTP 401 (authorization required)"
              reject(
                new McpAuthError(
                  `MCP '${this.name}' server responded HTTP 401 (authorization required).`,
                  "auth-required",
                ),
              )
              return
            }
            if (status >= 400) {
              this.lastError = `HTTP ${status}`
              reject(
                new Error(
                  `MCP '${this.name}': HTTP ${status} from ${this.spec.url}${buf ? `: ${buf.slice(0, 300)}` : ""}`,
                ),
              )
              return
            }
            try {
              // SSE / JSON-RPC batch: scan EVERY data: frame for the matching
              // id (the old code parsed only the last line, so multi-event
              // streams and interleaved notifications mis-resolved).
              const frames = buf
                .split("\n")
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).trim())
                .filter((l) => l.length > 0 && l !== "[DONE]")
              let matched: {
                id?: number
                result?: unknown
                error?: { code: number; message: string; data?: unknown }
              } | null = null
              let parsedAny = false
              for (const frame of frames) {
                try {
                  const msg = JSON.parse(frame) as {
                    id?: number
                    result?: unknown
                    error?: { code: number; message: string; data?: unknown }
                  }
                  parsedAny = true
                  if (msg.id !== undefined && msg.id !== id) continue
                  matched = msg
                  break
                } catch {
                  /* keep scanning frames */
                }
              }
              const msg =
                matched ??
                (parsedAny
                  ? null
                  : (JSON.parse(buf) as {
                      id?: number
                      result?: unknown
                      error?: { code: number; message: string; data?: unknown }
                    }))
              if (!msg) {
                throw new Error("no JSON-RPC response for this request in the stream")
              }
              if (msg.id !== undefined && msg.id !== id) return
              if (msg.error) {
                reject(new McpError(msg.error.code, msg.error.message, msg.error.data))
              } else {
                this.lastError = ""
                resolve(msg.result)
              }
            } catch (e) {
              this.lastError = e instanceof Error ? e.message : String(e)
              reject(
                new Error(
                  `MCP ${this.name}: bad response from ${this.spec.url}: ${e instanceof Error ? e.message : String(e)}`,
                ),
              )
            }
          })
        },
      )
      req.on("error", (err) => {
        this.lastError = err.message
        reject(new Error(`MCP ${this.name}: ${err.message}`))
      })
      req.on("timeout", () => {
        req.destroy()
        this.lastError = "timeout"
        reject(new Error(`MCP ${this.name}: timeout`))
      })
      req.end(data)
    })
  }

  private rejectAll(err: Error): void {
    for (const [, waiter] of this.pending) waiter.reject(err)
    this.pending.clear()
  }
}

export function createMcpConnection(name: string, spec: McpServerSpec): McpConnection {
  return new McpConnection(name, spec)
}

// OAuth surface (see ./oauth.ts) - re-exported so callers like the CLI and the
// Ink TUI can run `mcp auth` / `mcp logout` / `mcp status` through one import.
export { McpAuthError } from "./oauth.js"
export {
  authorizeMcpServer,
  getValidAccessToken,
  getMcpAuthStatus,
  removeMcpAuth,
  authFilePath,
  clearOAuthCaches,
} from "./oauth.js"
export type { McpOAuthConfig, McpOAuthTokens, McpOAuthClientInfo, McpAuthEntry, McpAuthStatus } from "./oauth.js"

// Spawn resolution (see ./spawn-resolve.ts) — shared by the client, the
// runner tool, and the installer so every stdio spawn resolves shims first.
export {
  resolveExecutable,
  resolveMcpCommand,
  resolveNpmCliJs,
  resolveNpxCliJs,
  type ResolvedCommand,
} from "./spawn-resolve.js"
