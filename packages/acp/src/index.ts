/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Minimal Agent Client Protocol (ACP) server over stdio (JSON-RPC 2.0, line-delimited).
 * Methods: initialize, new_session, load_session, list_sessions, set_model, prompt, cancel.
 * Run: `trayambak acp` — compatible with ACP-capable editors (custom agent server).
 */

import * as readline from "readline"
import { Agent, loadConfig } from "../../../apps/runtime/src/index.js"
import { listTranscripts, createTranscript, readState } from "../../session-backends/src/transcript.js"

const PROTOCOL_VERSION = 1

interface RpcRequest {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

const sessions = new Map<string, { id: string }>()
const cancelled = new Set<string>()

function send(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function sendError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")
}

function notify(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
}

async function handlePrompt(id: number | string | undefined, params: Record<string, unknown>): Promise<void> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : createTranscript(process.cwd()).id
  const prompt = typeof params.prompt === "string" ? params.prompt : ""
  const model = typeof params.model === "string" ? params.model : undefined
  if (!prompt) {
    sendError(id, -32602, "missing 'prompt'")
    return
  }
  sessions.set(sessionId, { id: sessionId })
  const config = loadConfig(model ? { model } : {})
  const agent = new Agent({ config })
  try {
    await agent.run(prompt, (event) => {
      if (cancelled.has(sessionId)) return
      notify("session/update", { sessionId, event })
    })
    cancelled.delete(sessionId)
    send(id, { sessionId, stopReason: cancelled.has(sessionId) ? "cancelled" : "end_turn" })
  } catch (err) {
    sendError(id, -32000, err instanceof Error ? err.message : String(err))
  }
}

async function dispatch(req: RpcRequest): Promise<void> {
  const params = req.params ?? {}
  switch (req.method) {
    case "initialize":
      send(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, prompt: true, mcp: true, sessions: true },
        agentInfo: { name: "trayambak", version: "0.5.0" },
      })
      break
    case "new_session":
      {
        const workDir = typeof params.workDir === "string" ? params.workDir : process.cwd()
        const { id } = createTranscript(workDir)
        sessions.set(id, { id })
        send(req.id, { sessionId: id })
      }
      break
    case "load_session":
    case "resume_session":
      {
        const sid = params.sessionId as string
        const st = readState(sid)
        if (!st) sendError(req.id, -32001, `session not found: ${sid}`)
        else {
          sessions.set(sid, { id: sid })
          send(req.id, { sessionId: sid, state: st })
        }
      }
      break
    case "list_sessions":
      send(
        req.id,
        listTranscripts().map((t) => ({ sessionId: t.id, ...t.state })),
      )
      break
    case "set_model":
      send(req.id, { ok: true, model: params.model ?? null })
      break
    case "prompt":
      await handlePrompt(req.id, params)
      break
    case "cancel":
      if (typeof params.sessionId === "string") cancelled.add(params.sessionId)
      send(req.id, { ok: true })
      break
    default:
      sendError(req.id, -32601, `unknown method: ${req.method}`)
  }
}

export function runAcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on("line", (line) => {
    if (!line.trim()) return
    try {
      dispatch(JSON.parse(line) as RpcRequest).catch((err) => {
        try {
          const parsed = JSON.parse(line) as RpcRequest
          sendError(parsed.id, -32000, err instanceof Error ? err.message : String(err))
        } catch {
          /* ignore */
        }
      })
    } catch {
      /* malformed line */
    }
  })
}
