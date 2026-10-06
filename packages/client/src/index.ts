/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as http from "http"

export interface ClientOptions {
  baseUrl?: string
  /** Wall-clock cap per request. A hung server must not wedge the caller
   *  (slash handlers await these promises inside the TUI). */
  timeoutMs?: number
}

/** Wall-clock default: long enough for a slow local agent turn, short enough
 *  that a dead server shows an error instead of freezing the UI forever. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Health/state JSON responses are tiny — 256KB is already generous. */
const MAX_JSON_BYTES = 256 * 1024
/** Streamed agent events over one run: bounded so a malicious or broken
 *  server cannot grow the buffer without limit (`buf += chunk` was open-
 *  ended before). Matches the byte-transport-cap pattern used for MCP. */
const MAX_RUN_BYTES = 16 * 1024 * 1024

/** Minimal client for the trayambak local server. */
export class TrayambakClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number

  constructor(options: ClientOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? `http://127.0.0.1:${process.env.TRAYAMBAK_SERVER_PORT ?? 8787}`)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async health(): Promise<{ status: string; model: string }> {
    const raw = await this.getJson("/health")
    if (typeof raw !== "object" || raw === null || !("status" in raw) || !("model" in raw)) {
      throw new Error("unexpected health response")
    }
    return { status: String(raw.status), model: String(raw.model) }
  }

  /** Send a prompt and invoke `onEvent` for each streamed agent event. */
  run(prompt: string, onEvent: (event: unknown) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      /** Single exit: timeout, cap, socket error, premature close, or end all
       *  funnel here, so late duplicate events can never settle twice. */
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        settle(new Error(`client run timed out after ${this.timeoutMs}ms`))
        try {
          req.destroy()
        } catch {
          /* request not yet assigned (synchronous request construction failed) */
        }
      }, this.timeoutMs)
      if (typeof timer.unref === "function") timer.unref()

      const req = http.request(
        {
          hostname: this.baseUrl.hostname,
          port: this.baseUrl.port || 80,
          path: "/v1/agent",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let buf = ""
          let total = 0
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => {
            if (settled) return
            total += chunk.length
            if (total > MAX_RUN_BYTES) {
              settle(new Error(`client run exceeded byte transport cap (${MAX_RUN_BYTES} bytes)`))
              req.destroy()
              return
            }
            buf += chunk
            let idx: number
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, idx).trim()
              buf = buf.slice(idx + 2)
              if (frame.startsWith("data: ")) {
                const payload = frame.slice(6).trim()
                if (payload === "[DONE]") continue
                try {
                  onEvent(JSON.parse(payload))
                } catch {
                  /* ignore malformed frame */
                }
              }
            }
          })
          res.on("end", () => settle())
          res.on("error", (err: Error) => settle(err))
          // Premature close (server dies mid-stream): without this the
          // promise never settled and the caller awaited forever.
          res.on("close", () => settle(new Error("client run response closed before completion")))
        },
      )
      req.on("error", (err: Error) => settle(err))
      req.end(JSON.stringify({ prompt }))
    })
  }

  private getJson(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (err?: Error, value?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(value)
      }
      const timer = setTimeout(() => {
        settle(new Error(`client request timed out after ${this.timeoutMs}ms`))
        try {
          req.destroy()
        } catch {
          /* request not yet assigned (synchronous request construction failed) */
        }
      }, this.timeoutMs)
      if (typeof timer.unref === "function") timer.unref()

      const req = http.request(
        { hostname: this.baseUrl.hostname, port: this.baseUrl.port || 80, path, method: "GET" },
        (res) => {
          let buf = ""
          res.setEncoding("utf8")
          res.on("data", (c: string) => {
            if (settled) return
            buf += c
            if (buf.length > MAX_JSON_BYTES) {
              settle(new Error(`client response exceeded byte transport cap (${MAX_JSON_BYTES} bytes)`))
              req.destroy()
            }
          })
          res.on("end", () => {
            try {
              settle(undefined, JSON.parse(buf))
            } catch (e) {
              settle(e instanceof Error ? e : new Error(String(e)))
            }
          })
          res.on("error", (err: Error) => settle(err))
          res.on("close", () => settle(new Error("client response closed before completion")))
        },
      )
      req.on("error", (err: Error) => settle(err))
      req.end()
    })
  }
}
