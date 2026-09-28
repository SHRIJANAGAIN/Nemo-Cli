/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - see LICENSE for the full terms.
 */

/**
 * Bash tool — enhanced with OS-level sandbox spawning.
 *
 * Key improvements over original:
 * 1. Spawns under OS-level sandbox (seatbelt, landlock, Windows restricted token)
 * 2. Filters environment variables (no secrets leaked to child process)
 * 3. Output capping (256KB hard cap to prevent OOM)
 * 4. Process group kill (kills entire tree, not just direct child)
 * 5. Exec policy engine evaluation (.rules files)
 * 6. Violation detection and recording
 * 7. IO drain timeout (prevents hanging)
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { isCommandAllowed, isCommandDangerous } from "../../../../../packages/protocol/src/permissions.js"
import { textResult, truncateOutput, type Tool, type ToolContext, type ToolResult } from "../types.js"
import { detectSandboxType, OUTPUT_MAX_BYTES } from "../../../../../packages/sandbox/src/index.js"
import { evaluatePolicy } from "../../../../../packages/execpolicy/src/policy.js"
import { ProcessManager } from "../../../../../packages/core/src/process.js"
import { getSafeEnv, validateEnv } from "../../../../../packages/core/src/env_filter.js"

const definition: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command in the project working directory. Returns combined stdout/stderr with OS-level sandbox isolation, output capping, and process tree management.",
  executionMode: "sequential",
  parameters: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeout: {
        type: "number",
        description: "Optional timeout in seconds (max 300).",
      },
    },
  },
}

export function createBashTool(): Tool {
  return {
    definition,
    async execute(_toolCallId, args, signal, _onUpdate, context) {
      try {
        if (signal?.aborted) return textResult("aborted", true)
        const ctx: ToolContext = context as ToolContext
        const command = String(args.command ?? "")
        if (!command) return textResult("Missing 'command'.", true)

        const timeoutSec = typeof args.timeout === "number" ? Math.max(1, Math.min(300, args.timeout)) : 30
        const timeoutMs = timeoutSec * 1000
        const config = ctx.config
        const parts = config.shellCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [config.shellCommand]
        const shell = parts[0].replace(/^"|"$/g, "")
        const shellArgs = parts.slice(1)

        // ─── 1. Exec Policy Evaluation ───
        // Evaluate against .rules files (if any) and default deny rules
        const policyDecision = evaluatePolicy(command)
        if (policyDecision === "deny") {
          return textResult(`Permission denied by exec policy: ${command}`, true)
        }
        if (policyDecision === "ask") {
          const allowed = await ctx.requestPermission?.("bash", command, "Exec policy requires approval")
          if (allowed === false) {
            return textResult(`Permission denied by exec policy: ${command}`, true)
          }
        }

        // ─── 2. Permission System Check ───
        if (!isCommandAllowed("bash", command, ctx.permissions)) {
          const allowed = await ctx.requestPermission?.("bash", command, "Risky bash command blocked by permissions")
          if (allowed === false) {
            return textResult(`Permission denied for command: ${command}`, true)
          }
          if (allowed === undefined && isCommandDangerous("bash", command, ctx.permissions)) {
            return textResult(
              `Permission denied (headless): command matches a deny rule and no approver is available: ${command}`,
              true,
            )
          }
        }

        // ─── 3. Validate Environment (sanitized into the child below) ───
        validateEnv(process.env)

        // ─── 4. Determine Sandbox Type ───
        const perms = ctx.permissions as unknown as Record<string, unknown>
        const sandboxType = detectSandboxType(perms)
        const networkDisabled =
          perms.__networkPolicy && typeof perms.__networkPolicy === "object"
            ? (((perms.__networkPolicy as Record<string, unknown>).disableNetwork as boolean) ?? false)
            : false

        // ─── 5. Filter Environment Variables ───
        const safeEnv = getSafeEnv(process.env, sandboxType, networkDisabled)

        // ─── 6. Execute Under Sandbox ───
        return new Promise<ToolResult>((resolve) => {
          let settled = false
          const processManager = new ProcessManager()

          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true
              processManager.killAll().catch(() => {})
              resolve(textResult(`Command timed out after ${timeoutSec}s`, true))
            }
          }, timeoutMs)

          // Abort signal handling
          const onAbort = () => {
            if (!settled) {
              settled = true
              clearTimeout(timeout)
              processManager.killAll().catch(() => {})
              resolve(textResult("Command aborted", true))
            }
          }
          signal?.addEventListener("abort", onAbort, { once: true })

          // ─── Spawn with OS-level sandbox ───
          processManager
            .spawn({
              command: [shell, ...shellArgs, command],
              cwd: ctx.cwd,
              env: safeEnv,
              timeoutMs,
              outputCap: OUTPUT_MAX_BYTES,
              processGroup: true,
              signal,
            })
            .then(async ({ exitCode, output }) => {
              // Wait for output with capping
              const out = await output.catch(() => "")

              clearTimeout(timeout)
              signal?.removeEventListener("abort", onAbort)

              if (!settled) {
                settled = true
                const truncated = truncateOutput(out, config)
                const exitCodeResult = await exitCode.catch(() => 1)
                const isError = exitCodeResult !== 0
                const status = isError ? `\n\n[exit code ${exitCodeResult}]` : ""

                // Violations are recorded in the state DB by the sandbox layer;
                // the tool result itself stays clean.
                resolve(textResult(truncated.text + status, isError))
              }
            })
            .catch((err) => {
              if (!settled) {
                settled = true
                clearTimeout(timeout)
                signal?.removeEventListener("abort", onAbort)
                resolve(textResult(`Command failed: ${err.message}`, true))
              }
            })
        })
      } catch (error) {
        return textResult(`Bash error: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }
}
