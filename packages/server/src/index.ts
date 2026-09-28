/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as http from "http"
import { Agent, loadConfig } from "../../../apps/runtime/src/index.js"
import { createTelemetry } from "../../telemetry/src/index.js"
import { listTranscripts } from "../../session-backends/src/transcript.js"
import {
  createAppJwt,
  createInstallationToken,
  postIssueComment,
  routeGithubEvent,
  splitRepo,
  verifyWebhookSignature,
  type GithubJob,
} from "./github-app.js"

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
  info: { title: "Trayambak Agent API", version: "0.6.0" }, // keep in sync with root package.json
  paths: {
    "/health": { get: { summary: "Health check" } },
    "/v1/models": { get: { summary: "List models" } },
    "/v1/agent": { post: { summary: "Run agent (SSE)" } },
    "/api/sessions": { get: { summary: "List transcripts" } },
    "/webhooks/github": { post: { summary: "GitHub App webhook (HMAC verified)" } },
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
  const telemetry = createTelemetry(/*enabled*/ false)

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

    if (req.method === "POST" && req.url === "/webhooks/github") {
      // Fail closed: no secret configured means no webhooks accepted.
      const secret = process.env.GITHUB_WEBHOOK_SECRET ?? ""
      if (!secret) {
        res.writeHead(503, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "webhooks disabled (GITHUB_WEBHOOK_SECRET unset)" }))
        return
      }
      const chunks: Buffer[] = []
      let rawBytes = 0
      let oversize = false
      req.on("data", (c: Buffer) => {
        if (oversize) return
        const buf = typeof c === "string" ? Buffer.from(c, "utf8") : c
        rawBytes += buf.length
        if (rawBytes > MAX_BODY_BYTES) {
          oversize = true
          res.writeHead(413, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "body too large (max 1MB)" }))
          setImmediate(() => req.destroy())
          return
        }
        chunks.push(buf)
      })
      req.on("end", () => {
        if (oversize || req.destroyed) return
        const raw = Buffer.concat(chunks)
        const signature = req.headers["x-hub-signature-256"]
        if (!verifyWebhookSignature(secret, raw, Array.isArray(signature) ? signature[0] : signature)) {
          res.writeHead(401, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "bad signature" }))
          return
        }
        let payload: unknown = null
        try {
          payload = JSON.parse(raw.toString("utf8"))
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "invalid JSON" }))
          return
        }
        const event = req.headers["x-github-event"]
        const outcome = routeGithubEvent(Array.isArray(event) ? (event[0] ?? "") : (event ?? ""), payload)
        if (outcome.kind !== "job") {
          // Always 2xx for non-jobs so GitHub never retry-storms us.
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ ok: true, ...(outcome.kind === "ignored" ? { ignored: outcome.reason } : {}) }))
          return
        }
        res.writeHead(202, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true, accepted: true }))
        void runGithubJob(outcome.job, payload).catch((err) => {
          process.stderr.write(`[github-app] job failed: ${err instanceof Error ? err.message : String(err)}\n`)
        })
      })
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

/**
 * Execute an accepted GitHub job: run the agent in the job workspace, then
 * report back on the thread. Replies need App credentials (GITHUB_APP_ID +
 * GITHUB_PRIVATE_KEY, PEM text or a path to it); without them the run still
 * executes but the result only lands in the server log — fail loud, never
 * silent, so a misconfigured VPS is obvious, not mysterious.
 */
async function runGithubJob(job: GithubJob, payload: unknown): Promise<void> {
  const apiBase = process.env.GITHUB_API_BASE ?? "https://api.github.com"
  const started = new Date().toISOString()
  process.stdout.write(`[github-app] job ${job.repoFullName}#${job.issueNumber} started at ${started}\n`)
  const workspace = process.env.TRAYAMBAK_GITHUB_WORKSPACE ?? loadConfig().cwd
  const jobConfig = { ...loadConfig(), cwd: workspace }
  const agent = new Agent({ config: jobConfig })
  const messages = await agent.run(
    `GitHub request in ${job.repoFullName}${job.isPullRequest ? " (pull request" : " (issue"} #${job.issueNumber}):\n${job.task}`,
    () => {},
  )
  const reply = extractFinalText(messages)
  const appId = process.env.GITHUB_APP_ID ?? ""
  let key = process.env.GITHUB_PRIVATE_KEY ?? ""
  if (key && !key.includes("BEGIN")) {
    const fs = await import("node:fs")
    try {
      key = fs.readFileSync(key, "utf8")
    } catch {
      key = ""
    }
  }
  const installation = (payload as { installation?: { id?: unknown } } | null)?.installation
  const installationId = typeof installation?.id === "number" ? installation.id : 0
  if (!appId || !key || !installationId) {
    process.stdout.write(
      `[github-app] job done but no reply channel (need GITHUB_APP_ID + GITHUB_PRIVATE_KEY + installation id).\n--- result ---\n${reply}\n--- end ---\n`,
    )
    return
  }
  const jwt = createAppJwt(appId, key)
  const token = await createInstallationToken(apiBase, jwt, installationId)
  const { owner, repo } = splitRepo(job.repoFullName)
  const capped = reply.length > 60000 ? `${reply.slice(0, 60000)}\n\n…(truncated, full log on the VPS)` : reply
  await postIssueComment({ apiBase, token }, owner, repo, job.issueNumber, `## Trayambak result\n\n${capped}`)
  process.stdout.write(`[github-app] job ${job.repoFullName}#${job.issueNumber} replied\n`)
}

function extractFinalText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== "assistant") continue
    const parts = Array.isArray(m.content) ? m.content : []
    const text = parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          !!p && typeof p === "object" && (p as { type?: unknown }).type === "text",
      )
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return "(agent produced no text output)"
}
