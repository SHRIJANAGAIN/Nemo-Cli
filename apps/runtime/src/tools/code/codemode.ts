/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as vm from "node:vm"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

/**
 * Confined JavaScript evaluation (legacy code-mode parity, offline edition).
 *
 * Runs `code` synchronously inside a `node:vm` context whose ONLY injected
 * value is the `input` string — no host object crosses the boundary. Every
 * builtin the guest sees (Math/JSON/Array/String/parseInt/...) is the fresh
 * context's own realm intrinsic, so `.constructor.constructor("return
 * process")` yields the *guest* Function and dies with a ReferenceError.
 * (#114: the previous allowlist of host builtins plus host `console.log`
 * closures was a constructor bridge straight to host RCE — `Array.constructor`
 * returned the HOST Function, one call from `process`/`child_process`.)
 * Console capture is formatted by guest closures inside the guest realm, and
 * thenable/render/log introspection runs in-guest under the same `timeout` so
 * a hostile getter terminates loudly instead of hanging the host stack.
 * There is deliberately no require, process, fetch, timers, or filesystem.
 * Async completion values are rejected loudly (a promise can never settle
 * inside a synchronous run). Honest scope: node:vm with zero host objects is
 * defense-in-depth, not a hardened security boundary — pair it with the
 * sandbox/approval layers, never rely on it alone.
 */

const DEFAULT_TIMEOUT_MS = 2_000
const MAX_TIMEOUT_MS = 10_000
const MAX_OUTPUT_CHARS = 4_000
/** Console lines retained per run — a log-spam loop must not OOM the host before the timeout lands. */
const MAX_LOG_LINES = 200

export interface CodemodeOutcome {
  ok: boolean
  /** Captured console lines, in order. */
  logs: string[]
  /** JSON (or string) rendering of the completion value. Empty on error. */
  result: string
  /** Error message. Empty on success. */
  error: string
}

/** Guest-realm console bootstrap (#114): formatting and capture happen with
 *  in-guest closures and in-guest JSON, so no host function or builtin is
 *  reachable via `.constructor`, and a hostile `toJSON` dies with the run's
 *  timeout instead of looping on the host stack. IIFE-scoped so user code
 *  can declare its own `push`/`fmt` without a redeclaration clash. */
function consoleBootstrap(): string {
  return `;(() => {
  const fmt = (v) => {
    try {
      if (typeof v === "string") return v
      const j = JSON.stringify(v)
      return j === undefined ? String(v) : j
    } catch (e) {
      return String(v)
    }
  }
  const push = (...args) => {
    if (globalThis.__cmLogs.length < ${MAX_LOG_LINES}) globalThis.__cmLogs.push(args.map(fmt).join(" "))
    else globalThis.__cmDropped++
  }
  globalThis.__cmLogs = []
  globalThis.__cmDropped = 0
  globalThis.console = { log: push, info: push, warn: push, error: push, debug: push }
})()`
}

/** Cap console retention; note what was dropped so the model is never misled. */
function finalizeLogs(logs: string[], dropped: number): string[] {
  if (dropped <= 0) return logs
  return [...logs, `…[${dropped} more log lines dropped (cap ${MAX_LOG_LINES})]`]
}

/** Evaluate `code` in confinement. Pure apart from the clock. */
export function runCodemode(code: string, opts: { input?: string; timeoutMs?: number } = {}): CodemodeOutcome {
  const timeout = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)))
  // The ONLY injected value is a string primitive — no host object, hence no
  // constructor bridge to the host Function (#114). Everything else the guest
  // uses is its own realm's intrinsic. The contextified sandbox would
  // otherwise inherit the HOST Object.prototype, handing `globalThis.constructor`
  // the host Object/Function — null the chain so no host-side link remains.
  const sandbox: Record<string, unknown> = { input: opts.input ?? "" }
  Object.setPrototypeOf(sandbox, null)
  const context = vm.createContext(sandbox)
  try {
    vm.runInContext(consoleBootstrap(), context, { timeout, displayErrors: false })
  } catch {
    // Bootstrap is ours and trivially small; a failure here would be a Node
    // surprise, not user input — fall through, console stays undefined.
  }
  /** Guest-realm evaluation, bounded by `timeout` (hostile getters terminate). */
  const introspect = (expr: string): unknown => vm.runInContext(expr, context, { timeout, displayErrors: false })
  const readLogs = (): { logs: string[]; dropped: number } => {
    try {
      const raw = introspect("JSON.stringify([__cmLogs, __cmDropped])")
      // Primitive-only payload; bound it so tampering can't balloon the host parse.
      if (typeof raw !== "string" || raw.length > 8_000_000) return { logs: [], dropped: 0 }
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
        const lines = (parsed[0] as unknown[]).filter((entry): entry is string => typeof entry === "string")
        return { logs: lines, dropped: typeof parsed[1] === "number" ? parsed[1] : 0 }
      }
    } catch {
      // Terminated mid-run or tampered by the guest — report what survived.
    }
    return { logs: [], dropped: 0 }
  }
  const errorOut = (message: string): CodemodeOutcome => {
    const { logs, dropped } = readLogs()
    return { ok: false, logs: finalizeLogs(logs, dropped), result: "", error: message }
  }

  let completion: unknown
  try {
    completion = vm.runInContext(code, context, { timeout, displayErrors: false })
  } catch (error) {
    return errorOut(error instanceof Error ? error.message : String(error))
  }
  // Hand the completion back to its own realm for introspection so a hostile
  // then/toJSON getter is bounded by `timeout` instead of looping host-side.
  sandbox.__cmCompletion = completion
  try {
    const isAsync = introspect(
      "__cmCompletion !== null && (typeof __cmCompletion === 'object' || typeof __cmCompletion === 'function') && typeof __cmCompletion.then === 'function'",
    )
    if (isAsync === true) return errorOut("async results are not supported — return a plain value")
  } catch (error) {
    return errorOut(`completion introspection failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  let rendered: string
  try {
    const out = introspect(
      "(() => { try { const j = JSON.stringify(__cmCompletion); return j === undefined ? String(__cmCompletion) : j } catch (e) { return String(__cmCompletion) } })()",
    )
    rendered = typeof out === "string" ? out : String(out)
  } catch (error) {
    return errorOut(`rendering failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (rendered.length > MAX_OUTPUT_CHARS) rendered = rendered.slice(0, MAX_OUTPUT_CHARS) + "…[truncated]"
  const { logs, dropped } = readLogs()
  return { ok: true, logs: finalizeLogs(logs, dropped), result: rendered, error: "" }
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "codemode",
  description:
    "Evaluate confined synchronous JavaScript (no require/process/fetch/timers/filesystem). Receives `input` string, returns the completion value as JSON plus captured console output. Best for deterministic transforms, parsers, and calculators the model can verify by execution.",
  parameters: {
    type: "object",
    required: ["code"],
    properties: {
      code: { type: "string", description: "Synchronous JavaScript source. The completion value is returned." },
      input: { type: "string", description: "String passed in as `input`." },
      timeout_ms: { type: "number", description: "Execution cap in ms (100-10000, default 2000)." },
    },
  },
}

/** `codemode` tool: confined JS with captured console. */
export function createCodemodeTool(): Tool {
  return {
    definition,
    async execute(_id, args) {
      const code = String(args.code ?? "")
      if (!code.trim()) return textResult("Missing required parameter: code", /*isError*/ true)
      const outcome = runCodemode(code, {
        input: typeof args.input === "string" ? args.input : undefined,
        timeoutMs: typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
      })
      if (!outcome.ok) {
        const logs = outcome.logs.length > 0 ? `\nlogs:\n${outcome.logs.join("\n")}` : ""
        return textResult(`Error: ${outcome.error}${logs}`, /*isError*/ true)
      }
      const logs = outcome.logs.length > 0 ? `${outcome.logs.join("\n")}\n---\n` : ""
      return textResult(`${logs}${outcome.result}`)
    },
  }
}
