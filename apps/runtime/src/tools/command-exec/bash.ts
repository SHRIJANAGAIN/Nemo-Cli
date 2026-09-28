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
import { randomUUID } from "crypto"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "bash",
  description:
    "Run a shell command in the project working directory. Returns combined stdout/stderr with OS-level sandbox isolation, output capping, and process tree management. Pass background: true for long-running work: the command starts detached and you get a job_id back immediately — keep working, then poll bash with job_id to read the result (or action: 'kill' to stop it).",
  executionMode: "sequential",
  parameters: {
    type: "object",
    // Conditionally required: `command` for a new run, `job_id` when
    // polling/killing — execute() validates the shape at runtime.
    required: [],
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute. Required unless polling a job via 'job_id'.",
      },
      timeout: {
        type: "number",
        description: "Optional timeout in seconds (foreground max 300; background max 3600, default 600).",
      },
      background: {
        type: "boolean",
        description:
          "Start the command as a background job and return its job_id immediately instead of waiting for it to finish.",
      },
      job_id: {
        type: "string",
        description: "Background job to inspect (default) or kill instead of running a new command.",
      },
      action: {
        type: "string",
        enum: ["status", "kill"],
        description: "What to do with 'job_id': 'status' (default) returns progress/output, 'kill' stops the job.",
      },
    },
  },
}

// ─── Background job registry ───
// Started jobs outlive the tool call that spawned them: the ProcessManager
// handle is kept here so the agent can poll output or kill the tree later.

interface BgJob {
  id: string
  command: string
  cwd: string
  startedAt: number
  timeoutMs: number
  state: "running" | "done"
  pid?: number
  kill?: (signal?: string) => Promise<void>
  exitCode?: number
  output?: string
  settledAt?: number
  killRequested?: boolean
}

const MAX_BACKGROUND_JOBS = 8
/** Completed jobs stay readable for 10 minutes, then the sweep drops them. */
const COMPLETED_RETENTION_MS = 10 * 60 * 1000

const backgroundJobs = new Map<string, BgJob>()

function sweepBackgroundJobs(): void {
  const now = Date.now()
  for (const [id, job] of backgroundJobs) {
    if (job.state === "done" && job.settledAt !== undefined && now - job.settledAt > COMPLETED_RETENTION_MS) {
      backgroundJobs.delete(id)
    }
  }
}

/** Test hook: kill and forget every background job. */
export function resetBackgroundJobsForTests(): void {
  for (const job of backgroundJobs.values()) {
    if (job.state === "running") void job.kill?.().catch(() => {})
  }
  backgroundJobs.clear()
}

async function startBackgroundJob(opts: {
  command: string
  shell: string
  shellArgs: string[]
  ctx: ToolContext
  safeEnv: Record<string, string>
  timeoutMs: number
  timeoutSec: number
}): Promise<ToolResult> {
  sweepBackgroundJobs()
  const running = [...backgroundJobs.values()].filter((j) => j.state === "running").length
  if (running >= MAX_BACKGROUND_JOBS) {
    return textResult(
      `Too many background jobs running (${running}/${MAX_BACKGROUND_JOBS}). Poll existing jobs with job_id or kill them first.`,
      /*isError*/ true,
    )
  }

  const id = randomUUID()
  const job: BgJob = {
    id,
    command: opts.command,
    cwd: opts.ctx.cwd,
    startedAt: Date.now(),
    timeoutMs: opts.timeoutMs,
    state: "running",
  }
  backgroundJobs.set(id, job)

  const processManager = new ProcessManager()
  let handle: Awaited<ReturnType<ProcessManager["spawn"]>>
  try {
    // No AbortSignal: the job intentionally outlives the tool call.
    handle = await processManager.spawn({
      command: [opts.shell, ...opts.shellArgs, opts.command],
      cwd: opts.ctx.cwd,
      env: opts.safeEnv,
      timeoutMs: opts.timeoutMs,
      outputCap: OUTPUT_MAX_BYTES,
      processGroup: true,
    })
  } catch (e) {
    backgroundJobs.delete(id)
    return textResult(`Failed to start background job: ${e instanceof Error ? e.message : String(e)}`, /*isError*/ true)
  }

  job.pid = handle.pid
  job.kill = handle.kill
  void handle.exitCode
    .then(async (exitCode) => {
      const output = await handle.output.catch(() => "")
      job.output = output
      job.exitCode = exitCode
      job.settledAt = Date.now()
      job.state = "done"
    })
    .catch(() => {
      job.output = job.output ?? ""
      job.exitCode = 1
      job.settledAt = Date.now()
      job.state = "done"
    })

  return textResult(
    `Background job started.\njob_id: ${id}\ncommand: ${opts.command}\ntimeout: ${opts.timeoutSec}s\n\nPoll with bash({"job_id": "${id}"}) for status and output; stop it with bash({"job_id": "${id}", "action": "kill"}).`,
  )
}

async function handleJobOperation(jobId: string, action: unknown, ctx: ToolContext): Promise<ToolResult> {
  sweepBackgroundJobs()
  if (action !== undefined && action !== "status" && action !== "kill") {
    return textResult(`Unknown action '${String(action)}'. Use "status" or "kill".`, /*isError*/ true)
  }
  const job = backgroundJobs.get(jobId)
  if (!job) {
    return textResult(
      `Unknown job_id '${jobId}'. Jobs stay available for ${Math.round(COMPLETED_RETENTION_MS / 60000)} minutes after they finish.`,
      /*isError*/ true,
    )
  }

  if (action === "kill") {
    if (job.state === "done") {
      return textResult(`Job ${jobId} already finished (exit ${job.exitCode ?? "?"}).`)
    }
    job.killRequested = true
    await job.kill?.().catch(() => {})
    return textResult(`Job ${jobId} killed: ${job.command}`)
  }

  if (job.state === "running") {
    const elapsed = Math.round((Date.now() - job.startedAt) / 1000)
    return textResult(
      `Job ${jobId} still running (${elapsed}s)\ncommand: ${job.command}\ncwd: ${job.cwd}\nOutput is collected when the job finishes — poll again for the result.`,
    )
  }

  const truncated = truncateOutput(job.output ?? "", ctx.config)
  const notes: string[] = []
  if (job.settledAt !== undefined && job.settledAt - job.startedAt >= job.timeoutMs) {
    notes.push(`[hit the ${Math.round(job.timeoutMs / 1000)}s timeout and was killed]`)
  }
  if (job.killRequested) notes.push("[killed on request]")
  if (job.exitCode !== 0) notes.push(`[exit code ${job.exitCode}]`)
  const noteText = notes.length > 0 ? `\n\n${notes.join("\n")}` : ""
  return textResult(
    `Job ${jobId} finished\ncommand: ${job.command}\n\n${truncated.text}${noteText}`,
    job.exitCode !== 0,
  )
}

export function createBashTool(): Tool {
  return {
    definition,
    async execute(_toolCallId, args, signal, _onUpdate, context) {
      try {
        if (signal?.aborted) return textResult("aborted", /*isError*/ true)
        const ctx: ToolContext = context as ToolContext

        // ─── 0. Background job management (poll/kill) — the command was
        //     already policy- and permission-checked when it started. ───
        if (typeof args.job_id === "string" && args.job_id.length > 0) {
          return await handleJobOperation(args.job_id, args.action, ctx)
        }

        const command = String(args.command ?? "")
        if (!command) return textResult("Missing 'command'.", /*isError*/ true)
        const background = args.background === true

        const timeoutSec = background
          ? typeof args.timeout === "number"
            ? Math.max(1, Math.min(3600, args.timeout))
            : 600
          : typeof args.timeout === "number"
            ? Math.max(1, Math.min(300, args.timeout))
            : 30
        const timeoutMs = timeoutSec * 1000
        const config = ctx.config
        const parts = config.shellCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [config.shellCommand]
        const shell = parts[0].replace(/^"|"$/g, "")
        const shellArgs = parts.slice(1)

        // ─── 1. Exec Policy Evaluation ───
        // Evaluate against .rules files (if any) and default deny rules
        const policyDecision = evaluatePolicy(command)
        if (policyDecision === "deny") {
          return textResult(`Permission denied by exec policy: ${command}`, /*isError*/ true)
        }
        if (policyDecision === "ask") {
          const allowed = await ctx.requestPermission?.("bash", command, "Exec policy requires approval")
          if (allowed === false) {
            return textResult(`Permission denied by exec policy: ${command}`, /*isError*/ true)
          }
        }

        // ─── 2. Permission System Check ───
        if (!isCommandAllowed("bash", command, ctx.permissions)) {
          const allowed = await ctx.requestPermission?.("bash", command, "Risky bash command blocked by permissions")
          if (allowed === false) {
            return textResult(`Permission denied for command: ${command}`, /*isError*/ true)
          }
          if (allowed === undefined && isCommandDangerous("bash", command, ctx.permissions)) {
            return textResult(
              `Permission denied (headless): command matches a deny rule and no approver is available: ${command}`,
              /*isError*/ true,
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

        // ─── 6. Background mode: same checks as foreground, but the job
        //     is handed to the registry and we return its id at once. ───
        if (background) {
          return await startBackgroundJob({ command, shell, shellArgs, ctx, safeEnv, timeoutMs, timeoutSec })
        }

        // ─── 7. Execute Under Sandbox ───
        return new Promise<ToolResult>((resolve) => {
          let settled = false
          const processManager = new ProcessManager()

          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true
              processManager.killAll().catch(() => {})
              resolve(textResult(`Command timed out after ${timeoutSec}s`, /*isError*/ true))
            }
          }, timeoutMs)

          // Abort signal handling
          const onAbort = () => {
            if (!settled) {
              settled = true
              clearTimeout(timeout)
              processManager.killAll().catch(() => {})
              resolve(textResult("Command aborted", /*isError*/ true))
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
                resolve(textResult(`Command failed: ${err.message}`, /*isError*/ true))
              }
            })
        })
      } catch (error) {
        return textResult(`Bash error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}
