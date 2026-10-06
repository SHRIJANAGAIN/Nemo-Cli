/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Minimal Agent Client Protocol (ACP) server over stdio (JSON-RPC 2.0, line-delimited).
 *
 * Speaks the spec names (`session/new`, `session/load`, `session/resume`,
 * `session/prompt`, `session/cancel`) and the short names they replaced, so
 * both spec clients and older callers work against the same server. Prompt
 * params arrive as a `ContentBlock[]`, and `session/update` carries a
 * spec-shaped `update` union built by {@link toSessionUpdate}.
 *
 * Run: `trayambak acp` — for ACP-capable editors (custom agent server).
 * Full wire reference: `docs/acp.md`.
 */

import * as readline from "readline"
import { Agent, loadConfig } from "../../../apps/runtime/src/index.js"
// Single-sourced: apps/cli/src/version.ts is stamped from the root
// package.json by scripts/sync-version.mjs on every build, so the
// advertised agentInfo version cannot go stale again (it said 0.6.0
// while the release was 0.6.7).
import { VERSION } from "../../../apps/cli/src/version.js"
import { listTranscripts, createTranscript, readState } from "../../session-backends/src/transcript.js"

const PROTOCOL_VERSION = 1

/** Ref'd keep-alive tick: effectively infinite, well under Node's 2^31-1 ms timer cap. */
const KEEP_ALIVE_TICK_MS = 1 << 30
/** How long the server outlives stdin EOF; see runAcpServer. */
const EXIT_GRACE_MS = 500

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

/** Spec method name → the handler `dispatch` already implements under its short name. */
const METHOD_ALIASES: Record<string, string> = {
  "session/new": "new_session",
  "session/load": "load_session",
  "session/resume": "resume_session",
  "session/prompt": "prompt",
  "session/cancel": "cancel",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * `PromptRequest.prompt` is a `ContentBlock[]` per spec; the short form this
 * server originally accepted was a bare string. Reduce either to the single
 * string the agent loop runs — non-text blocks contribute nothing.
 */
function promptText(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (!Array.isArray(raw)) return ""
  return raw
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
}

/**
 * Reduce an internal `AgentEvent` to one ACP `SessionUpdate` union member.
 *
 * Returns `undefined` for events ACP has no variant for. Those are dropped
 * rather than forwarded: an unknown `sessionUpdate` discriminator is a
 * protocol error on the client side, not a hint it is free to ignore.
 */
function toSessionUpdate(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event) || typeof event.type !== "string") return undefined
  switch (event.type) {
    case "message_update": {
      const delta = isRecord(event.delta) ? event.delta : {}
      if (typeof delta.text === "string" && delta.text.length > 0) {
        return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.text } }
      }
      if (typeof delta.thinking === "string" && delta.thinking.length > 0) {
        return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.thinking } }
      }
      return undefined
    }
    case "thinking":
      return typeof event.thinking === "string" && event.thinking.length > 0
        ? { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.thinking } }
        : undefined
    case "tool_execution_start": {
      if (typeof event.toolCallId !== "string") return undefined
      const name = typeof event.toolName === "string" ? event.toolName : ""
      const update: Record<string, unknown> = {
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        title: name.length > 0 ? name : "tool",
        status: "in_progress",
      }
      if (name.length > 0) update.name = name
      // `rawInput` is typed `object` in the spec — a string args payload would
      // fail validation, so only forward one we know round-trips.
      if (isRecord(event.args)) update.rawInput = event.args
      return update
    }
    case "tool_execution_update":
      return typeof event.toolCallId === "string"
        ? { sessionUpdate: "tool_call_update", toolCallId: event.toolCallId, status: "in_progress" }
        : undefined
    case "tool_execution_end": {
      if (typeof event.toolCallId !== "string") return undefined
      const update: Record<string, unknown> = {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: event.isError === true ? "failed" : "completed",
      }
      if (isRecord(event.result)) update.rawOutput = event.result
      return update
    }
    case "message_end": {
      // A failed run lands as ONE message_end with stopReason "error" —
      // its text never streams as chunks (the loop breaks on it). Without
      // this mapping the client got nothing at all while the prompt reply
      // still claimed end_turn. Normal final text already streamed as
      // message_update chunks, so only the error form maps here; forwarding
      // those too would duplicate the answer.
      const msg = isRecord(event.message) ? event.message : undefined
      if (msg?.stopReason !== "error") return undefined
      const text = (Array.isArray(msg.content) ? msg.content : [])
        .filter(
          (part): part is { type: "text"; text: string } =>
            isRecord(part) && part.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n")
      return text.length > 0
        ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
        : undefined
    }
    default:
      return undefined
  }
}

async function handlePrompt(id: number | string | undefined, params: Record<string, unknown>): Promise<void> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : createTranscript(process.cwd()).id
  const prompt = promptText(params.prompt)
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
  // Agent.create (not the constructor) loads config-driven tools — MCP
  // servers + skills — so an ACP session actually connects what the config
  // declares; the constructor path skipped buildOptionalTools entirely (#62).
  const agent = await Agent.create({ config })
  // The assistant's own stopReason must drive the reply: an errored run
  // answered "end_turn" was half the silent-failure defect (the other
  // half is toSessionUpdate forwarding the error text).
  let assistantStopReason: string | undefined
  try {
    await agent.run(prompt, (event) => {
      if (cancelled.has(sessionId)) return
      if (
        isRecord(event) &&
        event.type === "message_end" &&
        isRecord(event.message) &&
        typeof event.message.stopReason === "string"
      ) {
        assistantStopReason = event.message.stopReason
      }
      const update = toSessionUpdate(event)
      if (update === undefined) return
      notify("session/update", { sessionId, update })
    })
    // Read the cancel flag BEFORE clearing it — deleting first made
    // `stopReason: "cancelled"` unreachable (every reply said "end_turn",
    // even mid-cancel ones).
    const wasCancelled = cancelled.has(sessionId)
    // ACP's stopReason vocabulary: internal "aborted" reads as
    // "cancelled", "error" stays "error", and everything the loop
    // completed (end_turn/tool_use/length) is end_turn.
    const stopReason =
      wasCancelled || assistantStopReason === "aborted"
        ? "cancelled"
        : assistantStopReason === "error"
          ? "error"
          : "end_turn"
    send(id, { sessionId, stopReason })
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
  // Spec names and the short names they replaced reach the same handlers; the
  // switch still keys on the short name so `default` can report the original.
  switch (METHOD_ALIASES[req.method] ?? req.method) {
    case "initialize":
      send(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        // Spec-shaped only: a client reads `promptCapabilities`/`mcpCapabilities`
        // and silently discards the short keys we used to send here, so those
        // advertised nothing at all.
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false, acp: false },
          sessionCapabilities: {},
          auth: {},
        },
        agentInfo: { name: "trayambak", version: VERSION }, // stamped from root package.json by sync-version
      })
      break
    case "new_session":
      {
        // `cwd` is the spec field; `workDir` is this server's original short name.
        const workDir =
          typeof params.cwd === "string"
            ? params.cwd
            : typeof params.workDir === "string"
              ? params.workDir
              : process.cwd()
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
  // ACP: the agent serves until stdin closes. Readline's line listeners
  // alone are not a guarantee of that — with the harness still holding
  // stdin open, a drained event loop exits the process early, the
  // harness's cleanup then signals a dead pid (ProcessLookupError) and
  // records the whole already-successful run as a failure (exit 1, seen
  // live in harbor's acp_runner after a correct, verified answer). Pin
  // the loop for the whole session instead.
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_TICK_MS)
  // stdin EOF: drop the pin, but hold the pid for one beat — harnesses
  // close stdin and then terminate in the same instant, and exiting first
  // turns their kill into ProcessLookupError. After the grace nothing
  // is ref'd, the loop drains and Node exits normally (stdout has
  // flushed too).
  let pinReleased = false
  const releasePin = (): void => {
    if (pinReleased) return
    pinReleased = true
    clearInterval(keepAlive)
    setTimeout(() => {}, EXIT_GRACE_MS)
  }
  // Readline emits "close" on input *EOF* only — a destroyed or errored
  // pipe emits the input's own "close" without ever feeding readline an
  // 'end', which would leave the pin held forever (zombie server). Both
  // paths release, exactly once.
  rl.on("close", releasePin)
  process.stdin.on("close", releasePin)
  // A stdin that ended before createInterface got here would never emit
  // "close" on its own; close explicitly so the pin is released.
  if (process.stdin.readableEnded) rl.close()
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
