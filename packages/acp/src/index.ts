/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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

const sessions = new Map<string, { id: string; model?: string }>()
const cancelled = new Set<string>()
/** Model chosen via `set_model` without a sessionId — the fallback for later
 *  prompts that don't name one. Session-scoped choices live on the session
 *  entry above. Previously `set_model` echoed `{ok:true}` and stored NOTHING
 *  (#60) — every reply here is now backed by state `prompt` actually reads. */
let chosenModel: string | undefined

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
  if (!prompt) {
    sendError(id, -32602, "missing 'prompt'")
    return
  }
  const existing = sessions.get(sessionId)
  // Explicit per-prompt model wins; otherwise the model `set_model` stored
  // for this session, then the process-wide choice — never silently default
  // while replying ok to set_model (#60).
  const requested = typeof params.model === "string" ? params.model : undefined
  const model = requested || existing?.model || chosenModel
  sessions.set(sessionId, existing ?? { id: sessionId })
  const config = loadConfig(model ? { model } : {})
  const agent = new Agent({ config })
  try {
    await agent.run(prompt, (event) => {
      if (cancelled.has(sessionId)) return
      notify("session/update", { sessionId, event })
    })
    // Read the cancel flag BEFORE clearing it — deleting first made
    // `stopReason: "cancelled"` unreachable (every reply said "end_turn",
    // even mid-cancel ones).
    const wasCancelled = cancelled.has(sessionId)
    send(id, { sessionId, stopReason: wasCancelled ? "cancelled" : "end_turn" })
  } catch (err) {
    sendError(id, -32000, err instanceof Error ? err.message : String(err))
  } finally {
    // Clear on every exit (success *and* failure): a flag leaked past a
    // rejected run would suppress all events of the next prompt on this
    // session and mislabel it "cancelled".
    cancelled.delete(sessionId)
  }
}

async function dispatch(req: RpcRequest): Promise<void> {
  const params = req.params ?? {}
  switch (req.method) {
    case "initialize":
      send(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, prompt: true, mcp: true, sessions: true },
        agentInfo: { name: "trayambak", version: "0.6.0" }, // keep in sync with root package.json
      })
      break
    case "new_session":
      {
        const workDir = typeof params.workDir === "string" ? params.workDir : process.cwd()
        const { id } = createTranscript(workDir)
        sessions.set(id, sessions.get(id) ?? { id })
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
          // Preserve a model stored by an earlier set_model for this id —
          // overwriting the entry would silently drop it (#60).
          sessions.set(sid, sessions.get(sid) ?? { id: sid })
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
      {
        const raw = params.model
        if (raw !== undefined && raw !== null && typeof raw !== "string") {
          sendError(req.id, -32602, "'model' must be a string or null")
          break
        }
        const model = typeof raw === "string" && raw.length > 0 ? raw : undefined
        const sid = typeof params.sessionId === "string" ? params.sessionId : undefined
        if (sid) {
          const entry = sessions.get(sid) ?? { id: sid }
          entry.model = model
          sessions.set(sid, entry)
        } else {
          chosenModel = model
        }
        send(req.id, { ok: true, model: model ?? null })
      }
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
