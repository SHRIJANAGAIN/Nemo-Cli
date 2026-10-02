/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { getSafeEnv } from "../../../../../packages/core/src/env_filter.js"
import { ProcessManager } from "../../../../../packages/core/src/process.js"
import { textResult, type Tool } from "../types.js"

const monitorDef: ToolDefinition = {
  timeoutMs: 30_000,
  name: "trayambak__Monitor",
  description:
    "Watch a command and re-invoke the agent when the output matches a pattern. Useful for long-running processes or log tailing.",
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "Command to run (re-run every poll interval)." },
      pattern: { type: "string", description: "Regex pattern; agent is re-invoked only when output matches." },
      interval_ms: { type: "number", description: "Poll interval in ms. Default 5000." },
      max_runs: { type: "number", description: "Maximum number of polls. Default 60." },
    },
  },
}

/** Repo-wide 256KB process-output cap: a runaway child must not balloon
 *  memory while its output is buffered between polls. */
const MAX_POLL_OUTPUT_BYTES = 256 * 1024
/** Per-poll hard kill — under the 30s tool timeout, so a hung command is
 *  collected (partial output) instead of orphaning the child. */
const POLL_HARD_TIMEOUT_MS = 25_000

export function createMonitorTool(onMatch?: (output: string, command: string) => Promise<string>): Tool {
  return {
    definition: monitorDef,
    async execute(_id, args, signal) {
      const command = String(args.command ?? "")
      const pattern = args.pattern ? new RegExp(String(args.pattern)) : null
      const interval = typeof args.interval_ms === "number" ? args.interval_ms : 5000
      const maxRuns = typeof args.max_runs === "number" ? args.max_runs : 60
      if (!command) return textResult("Missing 'command'.", /*isError*/ true)
      const isWindows = process.platform === "win32"
      const shellBin = isWindows ? "cmd" : "/bin/sh"
      // cmd /d /s /c with the whole command wrapped in one extra quote pair:
      // /s strips exactly that outer pair, otherwise cmd's quote rules mangle
      // quoted paths ("C:\Program Files\…"). sh takes the raw string.
      const shellArgs = isWindows ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command]
      const outputs: string[] = []
      for (let i = 0; i < maxRuns; i++) {
        if (signal?.aborted) break
        const out = await runPoll(shellBin, shellArgs, signal)
        const matched = !pattern || pattern.test(out)
        outputs.push(`[poll ${i + 1} matched=${matched}] ${out.slice(0, 200)}`)
        if (matched) {
          if (onMatch) {
            const note = await onMatch(out, command)
            outputs.push(`[agent note] ${note}`)
          }
          return textResult(outputs.join("\n\n"))
        }
        if (i < maxRuns - 1) await new Promise((r) => setTimeout(r, interval))
      }
      return textResult(outputs.join("\n\n"))
    },
  }
}

/** One poll. Delegates to ProcessManager — the same lifecycle machinery
 *  `bash` uses: filtered env (#76: monitor's `command` is model-steered, so
 *  without this it could dump raw secrets into context while `bash` cannot),
 *  process-tree kill on abort/timeout (no orphaned grandchildren — the old
 *  bare `child.kill()` left them holding the pipes open), the repo-wide
 *  256KB output cap, and spawn failures surfaced as output instead of an
 *  unhandled 'error' event. */
async function runPoll(shellBin: string, shellArgs: string[], signal: AbortSignal | undefined): Promise<string> {
  const manager = new ProcessManager()
  let handle: Awaited<ReturnType<ProcessManager["spawn"]>>
  try {
    handle = await manager.spawn({
      command: [shellBin, ...shellArgs],
      cwd: process.cwd(),
      env: getSafeEnv(process.env),
      timeoutMs: POLL_HARD_TIMEOUT_MS,
      outputCap: MAX_POLL_OUTPUT_BYTES,
      processGroup: true,
      signal,
      // [shell, /c, <raw command>] must reach cmd.exe as typed (#75).
      windowsVerbatimArguments: true,
    })
  } catch (e) {
    return `spawn failed: ${e instanceof Error ? e.message : String(e)}`
  }
  // null exit = killed (abort/timeout); output still carries whatever the
  // child printed before it died.
  const exit = await handle.exitCode.then((code) => code).catch(() => null)
  const out = await handle.output.catch(() => "")
  if (out === "" && exit !== null && exit !== 0) return `[exit code ${exit}]`
  return out
}
