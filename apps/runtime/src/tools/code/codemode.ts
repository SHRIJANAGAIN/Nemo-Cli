/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as vm from "node:vm"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

/**
 * Confined JavaScript evaluation (legacy code-mode parity, offline edition).
 *
 * Runs `code` synchronously inside a `node:vm` context whose globals are an
 * explicit allowlist: `input`, a capturing `console`, and pure builtins
 * (Math/JSON/collections/...). There is deliberately NO require, process,
 * fetch, timers, or filesystem — code that touches them fails with a
 * ReferenceError instead of reaching the host. Async completion values are
 * rejected loudly (a promise can never settle inside a synchronous run).
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

function formatArg(value: unknown): string {
  if (typeof value === "string") return value
  try {
    const rendered = JSON.stringify(value)
    return rendered === undefined ? String(value) : rendered
  } catch {
    return String(value)
  }
}

/** Cap console retention; note what was dropped so the model is never misled. */
function finalizeLogs(logs: string[], dropped: number): string[] {
  if (dropped <= 0) return logs
  return [...logs, `…[${dropped} more log lines dropped (cap ${MAX_LOG_LINES})]`]
}

/** Evaluate `code` in confinement. Pure apart from the clock. */
export function runCodemode(code: string, opts: { input?: string; timeoutMs?: number } = {}): CodemodeOutcome {
  const logs: string[] = []
  let droppedLogs = 0
  const pushLog = (...args: unknown[]): void => {
    if (logs.length >= MAX_LOG_LINES) {
      droppedLogs += 1
      return
    }
    logs.push(args.map(formatArg).join(" "))
  }
  const sandbox: Record<string, unknown> = {
    input: opts.input ?? "",
    console: { log: pushLog, info: pushLog, warn: pushLog, error: pushLog, debug: pushLog },
    Math,
    JSON,
    String,
    Number,
    Boolean,
    BigInt,
    Array,
    Object,
    Date,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
  }
  const context = vm.createContext(sandbox)
  const timeout = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)))
  let completion: unknown
  try {
    completion = vm.runInContext(code, context, { timeout, displayErrors: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, logs: finalizeLogs(logs, droppedLogs), result: "", error: message }
  }
  if (completion !== null && (typeof completion === "object" || typeof completion === "function")) {
    const thenable = (completion as { then?: unknown }).then
    if (typeof thenable === "function") {
      return {
        ok: false,
        logs: finalizeLogs(logs, droppedLogs),
        result: "",
        error: "async results are not supported — return a plain value",
      }
    }
  }
  let rendered: string
  try {
    const json = JSON.stringify(completion)
    rendered = json === undefined ? String(completion) : json
  } catch {
    rendered = String(completion)
  }
  if (rendered.length > MAX_OUTPUT_CHARS) rendered = rendered.slice(0, MAX_OUTPUT_CHARS) + "…[truncated]"
  return { ok: true, logs: finalizeLogs(logs, droppedLogs), result: rendered, error: "" }
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
