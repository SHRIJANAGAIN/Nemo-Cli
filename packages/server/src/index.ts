/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as http from "http"
import { Agent, loadConfig } from "../../../apps/runtime/src/index.js"
import { createTelemetry } from "../../telemetry/src/index.js"
import { listTranscripts } from "../../session-backends/src/transcript.js"

export interface ServerOptions {
  port?: number
  host?: string
  token?: string
  lanOnly?: boolean
}

/** Max JSON body accepted on POST routes (DoS guard — unbounded concat). */
const MAX_BODY_BYTES = 1_048_576

export const OPENAPI_SPEC = {
  openapi: "3.0.0",
  info: { title: "Trayambak Agent API", version: "0.5.0" },
  paths: {
    "/health": { get: { summary: "Health check" } },
    "/v1/models": { get: { summary: "List models" } },
    "/v1/agent": { post: { summary: "Run agent (SSE)" } },
    "/api/sessions": { get: { summary: "List transcripts" } },
    "/openapi.json": { get: { summary: "OpenAPI spec" } },
  },
} as const

/**
 * A local HTTP server that exposes the trayambak agent over a small JSON/SSE API,
 * mirroring the server packages found in reference agent projects. The agent
 * itself still runs locally against llama.cpp; this just adds a network surface.
 */
export function startServer(options: ServerOptions = {}): http.Server {
  const port = options.port ?? Number(process.env.TRAYAMBAK_SERVER_PORT ?? 8787)
  const host = options.host ?? "127.0.0.1"
  const token = options.token ?? process.env.TRAYAMBAK_WEB_TOKEN
  const config = loadConfig()
  const telemetry = createTelemetry(false)

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }
    if (token && req.url !== "/health") {
      const auth = req.headers.authorization ?? ""
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "unauthorized" }))
        return
      }
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", model: config.model }))
      return
    }

    if (req.method === "GET" && req.url === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(OPENAPI_SPEC))
      return
    }

    if (req.method === "GET" && req.url === "/api/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" })
      try {
        res.end(JSON.stringify({ sessions: listTranscripts() }))
      } catch {
        res.end(JSON.stringify({ sessions: [] }))
      }
      return
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: config.model }] }))
      return
    }

    if (req.method === "POST" && req.url === "/v1/agent") {
      let body = ""
      let bodyBytes = 0
      let rejected = false
      // Abort the agent run when the client goes away mid-stream, so a
      // dropped SSE connection cannot leave a model turn burning tokens
      // forever on the VPS.
      const controller = new AbortController()
      req.on("close", () => controller.abort())
      req.on("data", (c) => {
        if (rejected) return
        const chunk = typeof c === "string" ? c : c.toString("utf8")
        bodyBytes += Buffer.byteLength(chunk)
        if (bodyBytes > MAX_BODY_BYTES) {
          rejected = true
          res.writeHead(413, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "body too large (max 1MB)" }))
          // Destroy only after the 413 flushes — killing the socket first
          // turns into ECONNRESET on the client instead of a clean 413.
          setImmediate(() => req.destroy())
          return
        }
        body += chunk
      })
      req.on("end", () => {
        if (rejected || req.destroyed) return
        const parsed = safeJson(body)
        const prompt = typeof parsed.prompt === "string" ? parsed.prompt : undefined
        const sessionFile = typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined
        if (!prompt || typeof prompt !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "missing 'prompt'" }))
          return
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        const agent = new Agent({ config, sessionFile })
        const safeWrite = (chunk: string): void => {
          try {
            if (!req.destroyed && !res.writableEnded) res.write(chunk)
          } catch {
            controller.abort()
          }
        }
        agent
          .run(
            prompt,
            (event) => {
              telemetry.capture(event)
              safeWrite(`data: ${JSON.stringify(event)}\n\n`)
            },
            controller.signal,
          )
          .then(() => {
            safeWrite("data: [DONE]\n\n")
            try {
              if (!req.destroyed && !res.writableEnded) res.end()
            } catch {
              /* client already gone */
            }
          })
          .catch((err) => {
            safeWrite(`data: ${JSON.stringify({ error: String(err) })}\n\n`)
            try {
              if (!req.destroyed && !res.writableEnded) res.end()
            } catch {
              /* client already gone */
            }
          })
      })
      return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "not found" }))
  })

  server.listen(port, host, () => {
    process.stdout.write(`trayambak server listening on http://${host}:${port}\n`)
  })
  return server
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
