/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as http from "http"

export interface ClientOptions {
  baseUrl?: string
}

/** Minimal client for the trayambak local server. */
export class TrayambakClient {
  private readonly baseUrl: URL

  constructor(options: ClientOptions = {}) {
    this.baseUrl = new URL(options.baseUrl ?? `http://127.0.0.1:${process.env.TRAYAMBAK_SERVER_PORT ?? 8787}`)
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
          res.setEncoding("utf8")
          res.on("data", (chunk: string) => {
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
          res.on("end", () => resolve())
        },
      )
      req.on("error", reject)
      req.end(JSON.stringify({ prompt }))
    })
  }

  private getJson(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: this.baseUrl.hostname, port: this.baseUrl.port || 80, path, method: "GET" },
        (res) => {
          let buf = ""
          res.on("data", (c) => (buf += c))
          res.on("end", () => {
            try {
              resolve(JSON.parse(buf))
            } catch (e) {
              reject(e)
            }
          })
        },
      )
      req.on("error", reject)
      req.end()
    })
  }
}
