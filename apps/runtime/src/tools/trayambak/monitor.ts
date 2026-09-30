/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { spawn } from "child_process"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
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

export function createMonitorTool(onMatch?: (output: string, command: string) => Promise<string>): Tool {
  return {
    definition: monitorDef,
    async execute(_id, args, signal) {
      const command = String(args.command ?? "")
      const pattern = args.pattern ? new RegExp(String(args.pattern)) : null
      const interval = typeof args.interval_ms === "number" ? args.interval_ms : 5000
      const maxRuns = typeof args.max_runs === "number" ? args.max_runs : 60
      if (!command) return textResult("Missing 'command'.", /*isError*/ true)
      const outputs: string[] = []
      for (let i = 0; i < maxRuns; i++) {
        if (signal?.aborted) break
        const out = await new Promise<string>((resolve) => {
          const proc = spawn("cmd", ["/c", command], { shell: true, windowsHide: true })
          let buf = ""
          proc.stdout?.on("data", (d) => (buf += d.toString()))
          proc.stderr?.on("data", (d) => (buf += d.toString()))
          proc.on("close", () => resolve(buf))
        })
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
