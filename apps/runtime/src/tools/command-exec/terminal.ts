/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { getSafeEnv } from "../../../../../packages/core/src/env_filter.js"

/**
 * Interactive terminal sessions (legacy PTY parity, dependency-free edition).
 *
 * Where the bash tool fires one-shot commands (plus detached background
 * jobs you can only poll), terminal sessions stay OPEN: the model starts a
 * shell, SENDS input lines to its stdin, and READS new output from any
 * offset — REPLs, multi-step shell flows, and long-lived dev servers. No
 * true TTY (that needs node-pty, deliberately not a dependency): programs
 * that require a TTY say so and the tool reports their complaint honestly.
 */

export const TERMINAL_MAX_SESSIONS = 4
export const TERMINAL_OUTPUT_CAP = 64 * 1024
export const TERMINAL_INPUT_CAP = 8 * 1024

export interface TerminalSession {
  id: string
  shell: string
  cwd: string
  startedAt: number
  live: boolean
  exitCode: number | null
  /** Total bytes ever appended (monotonic read cursor base). */
  totalBytes: number
}

interface LiveSession extends TerminalSession {
  child: ChildProcess
  buffer: string
  bufferBytes: number
}

const sessions = new Map<string, LiveSession>()

/** Test hook: kill everything and forget it. */
export function resetTerminalsForTests(): void {
  for (const session of sessions.values()) {
    try {
      killTree(session)
    } catch {
      /* ignore */
    }
  }
  sessions.clear()
}

function killTree(session: LiveSession): void {
  const pid = session.child.pid
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL")
      return
    } catch {
      /* fall through to direct kill */
    }
  }
  try {
    session.child.kill("SIGKILL")
  } catch {
    /* already dead */
  }
}

function appendOutput(session: LiveSession, chunk: string): void {
  session.buffer += chunk
  session.bufferBytes += Buffer.byteLength(chunk, "utf8")
  session.totalBytes += Buffer.byteLength(chunk, "utf8")
  if (session.bufferBytes > TERMINAL_OUTPUT_CAP) {
    const overflow = session.bufferBytes - TERMINAL_OUTPUT_CAP
    let cut = 0
    let bytes = 0
    while (cut < session.buffer.length && bytes < overflow) {
      bytes += Buffer.byteLength(session.buffer[cut]!, "utf8")
      cut++
    }
    session.buffer = session.buffer.slice(cut)
    session.bufferBytes -= bytes
  }
}

/** Public view of a session (handle and buffer stay inside). */
function publicView(session: LiveSession): TerminalSession {
  return {
    id: session.id,
    shell: session.shell,
    cwd: session.cwd,
    startedAt: session.startedAt,
    live: session.live,
    exitCode: session.exitCode,
    totalBytes: session.totalBytes,
  }
}
/** Start a shell session (binary path; compound commands like "bash -c" are split by the caller). Pure apart from spawn. */
export function createTerminalSession(shell: string, cwd: string, env: Record<string, string>): TerminalSession {
  const live = [...sessions.values()].filter((s) => s.live).length
  if (live >= TERMINAL_MAX_SESSIONS) {
    throw new Error(`Too many live terminals (${live}/${TERMINAL_MAX_SESSIONS}). Kill one first.`)
  }
  const child = spawn(shell, [], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  })
  const session: LiveSession = {
    id: randomUUID(),
    shell,
    cwd,
    startedAt: Date.now(),
    live: true,
    exitCode: null,
    totalBytes: 0,
    child,
    buffer: "",
    bufferBytes: 0,
  }
  child.stdout?.on("data", (chunk: Buffer) => appendOutput(session, chunk.toString("utf8")))
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(session, chunk.toString("utf8")))
  child.on("close", (code) => {
    session.live = false
    session.exitCode = code ?? 1
  })
  child.on("error", () => {
    session.live = false
    session.exitCode = session.exitCode ?? 1
  })
  sessions.set(session.id, session)
  return publicView(session)
}

/** Write a line to the session's stdin. */
export function sendTerminalInput(id: string, input: string): void {
  const session = sessions.get(id)
  if (!session) throw new Error(`Unknown terminal '${id}'.`)
  if (!session.live) throw new Error(`Terminal '${id}' exited (code ${session.exitCode ?? "?"}).`)
  if (Buffer.byteLength(input, "utf8") > TERMINAL_INPUT_CAP) {
    throw new Error(`Input exceeds ${TERMINAL_INPUT_CAP} bytes.`)
  }
  const writable = session.child.stdin
  if (!writable || writable.destroyed) throw new Error(`Terminal '${id}' stdin is closed.`)
  writable.write(input.endsWith("\n") ? input : input + "\n")
}

/** Read output appended after `fromBytes` (replay by cursor). */
export function readTerminalOutput(id: string, fromBytes = 0): { output: string; offset: number; live: boolean } {
  const session = sessions.get(id)
  if (!session) throw new Error(`Unknown terminal '${id}'.`)
  const dropped = session.totalBytes - session.bufferBytes
  const start = Math.max(0, fromBytes - dropped)
  return { output: session.buffer.slice(start), offset: session.totalBytes, live: session.live }
}

/** Kill a session (foreground: no-op when already exited). */
export function killTerminal(id: string): { exited: boolean; exitCode: number | null } {
  const session = sessions.get(id)
  if (!session) throw new Error(`Unknown terminal '${id}'.`)
  if (!session.live) return { exited: true, exitCode: session.exitCode }
  killTree(session)
  return { exited: false, exitCode: null }
}

export function listTerminals(): TerminalSession[] {
  return [...sessions.values()].map(publicView)
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "terminal",
  description:
    "Interactive shell sessions: create a persistent shell, send it input lines, and read new output from a cursor. For REPLs and multi-step shell flows; one-shot commands belong to bash. Actions: create, send, read, list, kill.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", description: "One of: create, send, read, list, kill." },
      shell: { type: "string", description: "Shell for create (default: the configured shellCommand)." },
      input: { type: "string", description: "Input line for send." },
      id: { type: "string", description: "Session id for send/read/kill." },
      offset: { type: "number", description: "Byte cursor for read (replay from here). Default 0." },
    },
  },
}

/** `terminal` tool: persistent interactive shells with replay. */
export function createTerminalTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext
      const action = String(args.action ?? "")
        .trim()
        .toLowerCase()
      switch (action) {
        case "create": {
          // shellCommand may be compound ("bash -c", "cmd /c") — a session
          // needs the bare binary; an explicit `shell` wins when given.
          const parts =
            typeof args.shell === "string" && args.shell.trim()
              ? [args.shell.trim()]
              : (ctx.config.shellCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [ctx.config.shellCommand])
          const shell = parts[0]!.replace(/^"|"$/g, "")
          try {
            const session = createTerminalSession(shell, ctx.cwd, getSafeEnv(process.env))
            return textResult(
              `Terminal started.\nid: ${session.id}\nshell: ${session.shell}\nSend input with terminal({"action": "send", "id": "${session.id}", "input": "..."})`,
            )
          } catch (error) {
            return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
          }
        }
        case "send": {
          const id = String(args.id ?? "")
          if (!id) return textResult("Missing 'id' for send.", /*isError*/ true)
          const input = String(args.input ?? "")
          if (!input) return textResult("Missing 'input' for send.", /*isError*/ true)
          try {
            sendTerminalInput(id, input)
            return textResult(`Sent to ${id}. Read it back with terminal({"action": "read", "id": "${id}"}).`)
          } catch (error) {
            return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
          }
        }
        case "read": {
          const id = String(args.id ?? "")
          if (!id) return textResult("Missing 'id' for read.", /*isError*/ true)
          const offset =
            typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0
          try {
            const { output, offset: next, live } = readTerminalOutput(id, offset)
            const head = `Terminal ${id} (${live ? "live" : "exited"}) — offset ${next}:\n`
            return textResult(output.length > 0 ? head + output : head + "(no new output yet)")
          } catch (error) {
            return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
          }
        }
        case "list": {
          const all = listTerminals()
          if (all.length === 0) return textResult("No terminals.")
          return textResult(
            all
              .map((s) => `- ${s.id} [${s.live ? "live" : `exited ${s.exitCode ?? "?"}`}] ${s.shell} @ ${s.cwd}`)
              .join("\n"),
          )
        }
        case "kill": {
          const id = String(args.id ?? "")
          if (!id) return textResult("Missing 'id' for kill.", /*isError*/ true)
          try {
            const result = killTerminal(id)
            return textResult(
              result.exited ? `Terminal ${id} already exited (${result.exitCode ?? "?"}).` : `Terminal ${id} killed.`,
            )
          } catch (error) {
            return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
          }
        }
        default:
          return textResult("Unknown action: use create, send, read, list, or kill.", /*isError*/ true)
      }
    },
  }
}
