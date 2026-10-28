/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Bash tool — enhanced with OS-level sandbox spawning.
 *
 * Key improvements over original:
 * 1. Spawns under OS-level sandbox when engaged (seatbelt/landlock behind
 *    the sandboxSpawn flag; in-process policy evaluation otherwise)
 * 2. Filters environment variables (no secrets leaked to child process)
 * 3. Output capping (256KB hard cap to prevent OOM)
 * 4. Process group kill (kills entire tree, not just direct child)
 * 5. Exec policy engine evaluation (.rules files)
 * 6. Violation detection and recording
 * 7. IO drain timeout (prevents hanging)
 */

import * as path from "path"

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { isCommandAllowed, isCommandDangerous } from "../../../../../packages/protocol/src/permissions.js"
import { textResult, truncateOutput, type Tool, type ToolContext, type ToolResult } from "../types.js"
import {
  detectSandboxType,
  filterEnv,
  OUTPUT_MAX_BYTES,
  shouldUseOsSandbox,
  spawnProcess,
  type SandboxType,
  type SpawnedProcess,
} from "../../../../../packages/sandbox/src/index.js"
import {
  hostPolicyFromPermissions,
  networkViolationForCommand,
} from "../../../../../packages/sandbox/src/network-policy.js"
import { recordNetworkViolation } from "../../../../../packages/sandbox/src/violation.js"
import { evaluatePolicy } from "../../../../../packages/execpolicy/src/policy.js"
import { ProcessManager } from "../../../../../packages/core/src/process.js"
import { getSafeEnv, validateEnv } from "../../../../../packages/core/src/env_filter.js"
import { checkAutoApproval } from "../../../../../packages/approval/src/index.js"
import { randomUUID } from "crypto"
import {
  forgetPersistedVerdict,
  persistNegativeVerdict,
  probeKey,
  readPersistedVerdict,
} from "./shell-probe-cache.js"

const definition: ToolDefinition = {
  // Outer-runner ceiling MUST cover the documented foreground max (300s):
  // it used to sit at 30s, so every foreground run died at 30s no matter
  // what the model asked for ("Tool timed out: bash (30000ms)" on builds).
  timeoutMs: 300_000,
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
        description: "Optional timeout in seconds (foreground max 300, default 300; background max 3600, default 600).",
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

/** Test hook: kill and forget every background job. Awaits the kills so the
 *  caller can tear down the temp dir afterwards — on Windows a job that is
 *  still shutting down holds its cwd open and the removal fails with EPERM. */
export function resetBackgroundJobsForTests(): Promise<void> {
  const kills: Array<Promise<unknown>> = []
  for (const job of backgroundJobs.values()) {
    if (job.state === "running" && job.kill) kills.push(job.kill().catch(() => {}))
  }
  backgroundJobs.clear()
  return Promise.all(kills).then(() => undefined)
}

/**
 * Truthful sandbox descriptor for tool output. Real isolation reports
 * `os (<type>)`; a downgraded spawn (MSYS shell that cannot run under
 * windows-restricted, or a failed handshake) reports `policy-only` and
 * carries the handle's reason — never `os (none)`, which claims an OS
 * sandbox it does not have.
 */
function sandboxDescriptor(p: SpawnedProcess): string {
  if (p.isSandboxed) return `os (${p.sandboxType})`
  return p.fallbackReason ? `policy-only — ${p.fallbackReason}` : "policy-only"
}

/**
 * The downgrade is explained ONCE per process.
 *
 * Repeating the caveat on every command buries it in noise: with the
 * persisted verdict the agent would re-read the same line on every single
 * call, and the one thing the line is for — "this shell is not OS-isolated"
 * — stops being visible. The first downgrade claims the note; later ones
 * stay quiet.
 */
let sandboxDowngradeReported = false

function claimSandboxDowngrade(reason: string | undefined): string {
  if (sandboxDowngradeReported) return ""
  sandboxDowngradeReported = true
  return `sandbox: policy-only — ${reason ?? "os isolation unavailable"}`
}

/**
 * Split a configured shell command into executable + trailing args
 * (`"C:\…\bash.exe" -c` → `bash` path + `["-c"]`, `cmd /c` → `cmd` +
 * `["/c"]`). One parser for both the run and the probe key, so the verdict
 * always applies to the argv that will actually be spawned.
 */
export function parseShellCommand(shellCommand: string): { shell: string; shellArgs: string[] } {
  const parts = shellCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [shellCommand]
  return { shell: parts[0].replace(/^"|"$/g, ""), shellArgs: parts.slice(1) }
}

/**
 * Whether `windowsVerbatimArguments` (#75: cmd.exe must see the raw
 * command text) is safe for this program — i.e. its argv[0] has no
 * spaces. Verbatim passes the command line UNQUOTED, so a spaced path
 * splits at the first space: the program starts (lpApplicationName is the
 * file) but the shell parses `Files\Git\…` as its script argument
 * ("No such file or directory"); pre-quoting the token instead lands the
 * quotes in lpApplicationName (ENOENT). Default quoting round-trips
 * correctly for CRT argv parsers (bash/sh — e.g. Git's spaced install
 * path), which is the only case this excludes from verbatim.
 */
function verbatimArgvSafe(bin: string): boolean {
  return !bin.includes(" ")
}

/** Session verdict for one shell: does its process chain survive the isolator? */
export interface ShellOsProbe {
  /** True when OS spawning may proceed (verified working, or not verifiable — see below). */
  ok: boolean
  /** Why it is policy-only, when known. */
  reason?: string
}

/** Probe deadline: covers the shim's one-time helper compile (STATUS_TIMEOUT_MS). */
const SHELL_OS_PROBE_TIMEOUT_MS = 60_000

const shellProbeCache = new Map<string, Promise<ShellOsProbe>>()

/** Test hook: pre-seed a verdict so unit tests never spawn a real probe. */
export function seedShellProbeForTests(shellCommand: string, outcome: ShellOsProbe): void {
  const { shell, shellArgs } = parseShellCommand(shellCommand)
  shellProbeCache.set(probeKey(shell, shellArgs), Promise.resolve(outcome))
}

/** Test hook: forget every cached verdict and re-arm the one-time note. */
export function resetShellProbeForTests(): void {
  shellProbeCache.clear()
  sandboxDowngradeReported = false
}

/**
 * True for modes that promise no mutation (plan / read-only).
 *
 * Derived from the live UI mode rather than the legacy `mode` alias, because
 * the UI mode is what the TUI sets at runtime and what the permission engine
 * already consults for the deny-list. `full-access` is deliberately NOT here:
 * it means "stop asking me", not "allow writes" — and giving the workspace
 * back its write grant under a mode named full-access would re-introduce the
 * exact surprise this replaces.
 */
export function isReadOnlyMode(perms: Record<string, unknown>): boolean {
  return perms.uiMode === "read-only" || perms.uiMode === "plan"
}

/**
 * Session probe: can this shell chain actually run under the OS sandbox?
 *
 * The probe spawns WRITABLE on purpose, even inside a plan/read-only session.
 * It answers "does the isolator accept this shell chain", and a policy refusal
 * (a read-only bind the launcher dislikes) would be indistinguishable from an
 * isolator refusal — and would park the whole session on the policy path,
 * silently REMOVING OS containment for every later command in that session.
 * Testing only the isolator keeps a policy-driven failure from weakening the
 * sandbox; the read-only grant is applied per real spawn below.
 *
 * Static detection (ac-workload.ts) catches shells that link MSYS/Cygwin
 * directly — but the shell `detectDefaultShell()` prefers on Windows is
 * Git's *dispatcher stub* (`Git\bin\bash.exe`, 47KB, imports no MSYS), and
 * the stub's child — the real `usr\bin\bash.exe` — dies inside the
 * AppContainer in DllMain before it can run `exit 0`. Only an empirical
 * spawn sees that chain, and it must run OUR trivial payload, never the
 * user's command: nothing the agent says can influence the verdict, so
 * forcing a downgrade stays impossible for repo-controlled input
 * (`shellCommand` from a repo-local config is stripped in config.ts).
 *
 * Verdicts cache per (shell, args) for the session — one probe spawn on
 * the first OS run, nothing after. A NEGATIVE verdict is additionally
 * persisted for the machine (shell-probe-cache.ts): the probe costs ~14 s
 * on Windows, so later processes must not re-pay it. An empty `shellArgs`
 * (exotic `[bin, command]` configs, e.g. a wrapper that takes the command
 * as its first argument) is not probe-able with a trailing payload, so it
 * proceeds exactly as before: `ok: true` means "engaged, still governed by
 * spawnProcess's own per-spawn handshake".
 */
async function probeShellUnderOsSandbox(opts: {
  shell: string
  shellArgs: string[]
  ctx: ToolContext
  safeEnv: Record<string, string>
  sandboxType: SandboxType
  networkDisabled: boolean
  spawnFn?: typeof spawnProcess
}): Promise<ShellOsProbe> {
  if (opts.shellArgs.length === 0) return { ok: true }
  const key = probeKey(opts.shell, opts.shellArgs)
  const existing = shellProbeCache.get(key)
  if (existing) return existing

  // An injected spawner is a test double: its verdict says nothing about
  // the machine, so it neither reads nor writes the persisted cache.
  const realSpawn = opts.spawnFn === undefined
  if (realSpawn) {
    const persisted = readPersistedVerdict(key, opts.shell)
    if (persisted) {
      const verdict = Promise.resolve<ShellOsProbe>(persisted)
      shellProbeCache.set(key, verdict)
      return verdict
    }
  }

  const pending = (async (): Promise<ShellOsProbe> => {
    let verdict: ShellOsProbe
    try {
      const proc = await (opts.spawnFn ?? spawnProcess)(
        osSpawnRequest({
          shell: opts.shell,
          shellArgs: opts.shellArgs,
          command: "exit 0",
          cwd: opts.ctx.cwd,
          env: opts.safeEnv,
          sandboxType: opts.sandboxType,
          networkDisabled: opts.networkDisabled,
          timeoutMs: SHELL_OS_PROBE_TIMEOUT_MS,
        }),
      )
      const code = await proc.waitForExit()
      if (!proc.isSandboxed) {
        // spawnProcess already refused this spawn (static MSYS detection
        // or a failed handshake) — its reason travels with every real run.
        verdict = { ok: false, reason: proc.fallbackReason ?? "os isolation unavailable for this spawn" }
      } else {
        // Sandboxed, and a payload that cannot legitimately fail did fail:
        // the workload chain is incompatible with the isolator.
        verdict =
          code === 0
            ? { ok: true }
            : { ok: false, reason: "shell cannot run under windows-restricted isolation" }
      }
    } catch (err) {
      verdict = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (realSpawn) {
      if (verdict.ok) forgetPersistedVerdict(key)
      else persistNegativeVerdict(key, opts.shell, verdict.reason ?? "os isolation unavailable")
    }
    return verdict
  })()
  shellProbeCache.set(key, pending)
  return pending
}

async function startBackgroundJob(opts: {
  command: string
  shell: string
  shellArgs: string[]
  ctx: ToolContext
  safeEnv: Record<string, string>
  timeoutMs: number
  timeoutSec: number
  sandboxType: SandboxType
  networkDisabled: boolean
  /** Mode-derived: emits an empty `writableRoots` (deny-all). */
  readOnly?: boolean
  spawnFn?: typeof spawnProcess
  osProbe?: ShellOsProbe
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

  // OS-sandbox path (flag-gated): the same spawnProcess every foreground
  // run uses — pid/kill/wait/read map 1:1 onto the job registry. The
  // session probe must also have approved this shell chain, otherwise the
  // job falls to the policy path below instead of dying per spawn.
  if (shouldUseOsSandbox(opts.sandboxType) && opts.osProbe?.ok === true) {
    let proc: SpawnedProcess
    try {
      proc = await (opts.spawnFn ?? spawnProcess)(
        osSpawnRequest({
          shell: opts.shell,
          shellArgs: opts.shellArgs,
          command: opts.command,
          cwd: opts.ctx.cwd,
          env: opts.safeEnv,
          sandboxType: opts.sandboxType,
          networkDisabled: opts.networkDisabled,
          timeoutMs: opts.timeoutMs,
          readOnly: opts.readOnly,
        }),
      )
    } catch (e) {
      backgroundJobs.delete(id)
      return textResult(
        `Failed to start background job: ${e instanceof Error ? e.message : String(e)}`,
        /*isError*/ true,
      )
    }
    job.pid = proc.pid
    job.kill = proc.kill
    // Attach readAll BEFORE waiting: calling it after waitForExit resolves
    // can miss bytes already delivered (streams drained → ""), silently
    // truncating job.output. With the fixed drain-on-exit readAll, calling
    // it while the child runs waits for exit internally instead of timing
    // out after IO_DRAIN_TIMEOUT_MS.
    const outputPromise = proc.readAll().catch(() => "")
    void proc
      .waitForExit()
      .then(async (exitCode) => {
        job.output = await outputPromise
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
      `Background job started.\njob_id: ${id}\ncommand: ${opts.command}\ntimeout: ${opts.timeoutSec}s\nsandbox: ${sandboxDescriptor(proc)}\n\nPoll with bash({"job_id": "${id}"}) for status and output; stop it with bash({"job_id": "${id}", "action": "kill"}).`,
    )
  }

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
      // Shell pattern needs cmd.exe to see the raw command text (#75);
      // a spaced program path must use default quoting instead (see
      // verbatimArgvSafe).
      windowsVerbatimArguments: verbatimArgvSafe(opts.shell),
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

  const downgraded = shouldUseOsSandbox(opts.sandboxType) && opts.osProbe !== undefined && !opts.osProbe.ok
  const downgrade = downgraded ? claimSandboxDowngrade(opts.osProbe?.reason) : ""
  const downgradeLine = downgrade ? `${downgrade}\n` : ""
  return textResult(
    `Background job started.\njob_id: ${id}\ncommand: ${opts.command}\ntimeout: ${opts.timeoutSec}s\n${downgradeLine}\nPoll with bash({"job_id": "${id}"}) for status and output; stop it with bash({"job_id": "${id}", "action": "kill"}).`,
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

export interface BashToolDeps {
  /** Override the OS-sandbox spawner (tests inject a stub; default is spawnProcess). */
  spawnFn?: typeof spawnProcess
}

/**
 * Build the spawnProcess request every OS-sandboxed bash run uses.
 *
 * `readOnlySubpaths` was hardcoded to `[]` while `filesystemPolicy` was not
 * consulted by the OS backends at all, so the empty list was harmless. Now that
 * `packages/sandbox/src/fs-policy.ts` actually applies the policy, a caller that
 * declares a read-only carve-out would silently lose it: `rm -rf .git` would
 * succeed inside a session whose policy promised `.git` was protected.
 *
 * The paths are resolved against `cwd` here rather than left relative, because
 * the OS layer compares absolute paths. `fs-policy.ts` compares path SEGMENTS, so
 * a relative carve-out like `.git` would never match the absolute path the mount
 * layer sees — resolving is what makes the two agree.
 */
export function osSpawnRequest(opts: {
  shell: string
  shellArgs: string[]
  command: string
  cwd: string
  env: Record<string, string>
  sandboxType: SandboxType
  networkDisabled: boolean
  timeoutMs: number
  /** Extra roots the policy allows writes to, in addition to `cwd`. */
  extraWritableRoots?: readonly string[]
  /** Paths inside the roots that stay read-only. Relative paths resolve to cwd. */
  readOnlySubpaths?: readonly string[]
  /**
   * True for modes that promise no mutation (plan / read-only). Emits an
   * EMPTY `writableRoots`, which `fs-policy.ts` defines as deny-all rather
   * than allow-all — the fail-closed direction, and the only reading under
   * which "read-only" means anything at the OS layer.
   */
  readOnly?: boolean
  signal?: AbortSignal
}): Parameters<typeof spawnProcess>[0] {
  // An already-absolute path is passed through UNCHANGED. `path.normalize` looks
// harmless but rewrites the separator style: on Windows it turns `/work` into
// `\work`, which means "root of the current drive" rather than the path the
// policy named. Corrupting a policy path is strictly worse than leaving it
// un-normalized, and de-duplication still works because equal strings compare
// equal.
const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(opts.cwd, p))
  const writableRoots =
    opts.readOnly === true
      ? []
      : [opts.cwd, ...(opts.extraWritableRoots ?? []).map(resolve)]
  return {
    command: [opts.shell, ...opts.shellArgs, opts.command],
    cwd: opts.cwd,
    sandboxType: opts.sandboxType,
    env: opts.env,
    networkPolicy: { disableNetwork: opts.networkDisabled, allowedDomains: [], blockedDomains: [] },
    filesystemPolicy: {
      // De-duplicated so a caller passing cwd as an extra root does not emit a
      // duplicate bubblewrap bind, which is a redundant mount, not a harmless one.
      writableRoots: [...new Set(writableRoots)],
      readOnlySubpaths: (opts.readOnlySubpaths ?? []).map(resolve),
      denyReadPaths: [],
      denyWritePaths: [],
    },
    outputCap: OUTPUT_MAX_BYTES,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  }
}

/**
 * Foreground run under OS isolation. Mirrors the ProcessManager path's
 * contract exactly (timeout/abort messages, truncation, exit-code suffix)
 * plus a truthful `[sandbox: …]` marker from the spawn handle — `os
 * (<type>)` when isolation really applied, `policy-only — <reason>` when
 * the spawner had to downgrade.
 */
export function runForegroundOsSandboxed(opts: {
  shell: string
  shellArgs: string[]
  command: string
  ctx: ToolContext
  safeEnv: Record<string, string>
  sandboxType: SandboxType
  networkDisabled: boolean
  timeoutMs: number
  timeoutSec: number
  signal: AbortSignal | undefined
  /** Mode-derived: emits an empty `writableRoots` (deny-all). */
  readOnly?: boolean
  spawnFn?: typeof spawnProcess
}): Promise<ToolResult> {
  const spawnFn = opts.spawnFn ?? spawnProcess
  return new Promise<ToolResult>((resolve) => {
    let settled = false
    let proc: SpawnedProcess | undefined
    const finish = (result: ToolResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        void proc?.kill("SIGKILL")
        resolve(textResult(`Command timed out after ${opts.timeoutSec}s`, /*isError*/ true))
      }
    }, opts.timeoutMs)
    const onAbort = (): void => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        void proc?.kill("SIGKILL")
        resolve(textResult("Command aborted", /*isError*/ true))
      }
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    spawnFn(
      osSpawnRequest({
        shell: opts.shell,
        shellArgs: opts.shellArgs,
        command: opts.command,
        cwd: opts.ctx.cwd,
        env: opts.safeEnv,
        sandboxType: opts.sandboxType,
        networkDisabled: opts.networkDisabled,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        readOnly: opts.readOnly,
      }),
    )
      .then(async (p) => {
        proc = p
        if (settled) {
          void p.kill("SIGKILL")
          return
        }
        const out = await p.readAll().catch(() => "")
        const exitCodeResult = await p.waitForExit()
        const truncated = truncateOutput(out, opts.ctx.config)
        const isError = exitCodeResult !== 0
        const status = isError ? `\n\n[exit code ${exitCodeResult}]` : ""
        finish(textResult(`${truncated.text}${status}\n\n[sandbox: ${sandboxDescriptor(p)}]`, isError))
      })
      .catch((err: unknown) => {
        finish(textResult(`Command failed: ${err instanceof Error ? err.message : String(err)}`, /*isError*/ true))
      })
  })
}

/**
 * Child environment for every bash run (audit 4.1).
 *
 * `getSafeEnv` (core) is deny-list only: DATABASE_URL, SENTRY_DSN,
 * SLACK_WEBHOOK, NPM_AUTH and DOCKER_CONFIG all pass straight through it.
 * `filterEnv` (sandbox) is deny patterns PLUS a 32-name allowlist, so an
 * unrecognised name is dropped by default - the right default for a shell.
 * Compose them: `filterEnv` first (allowlist + its 24 deny patterns),
 * then `getSafeEnv` for its extra deny patterns and for the authoritative
 * sandbox-metadata stamps it owns (the NEMO sandbox marker and its
 * network-disabled sibling - named here without the literal so the
 * marker tripwire in .github/workflows/check-forbidden-strings.yml still
 * means something). PATH, HOME, TEMP and USERPROFILE are all on the
 * allowlist, so real commands keep working.
 *
 * `permissions` is deliberately passed empty: bash has already computed
 * sandboxType/networkDisabled, and getSafeEnv stamps the metadata from
 * those explicit values (filterEnv's own stamp would be overwritten).
 */
export function buildBashEnv(
  processEnv: NodeJS.ProcessEnv,
  sandboxType: string,
  networkDisabled: boolean,
): Record<string, string> {
  const stringOnly: Record<string, string> = {}
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") stringOnly[key] = value
  }
  return getSafeEnv(filterEnv(stringOnly, {}), sandboxType, networkDisabled)
}

export function createBashTool(deps?: BashToolDeps): Tool {
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
        // Naming the accepted shapes matters: the model sent `{}` and got a bare
        // "Missing 'command'.", which reads as a tool failure rather than a
        // call-shape mistake, and it retried the same empty call.
        if (!command) {
          return textResult(
            "Missing 'command'. Send command as a string (plus optional timeout/background), or pass job_id with action \"status\"|\"kill\" to manage a background job.",
            /*isError*/ true,
          )
        }
        const background = args.background === true

        // Foreground default is the full 300s window (builds/tests run
        // minutes; aborts still cut it short): a 30s default killed every
        // un-timed long command at the outer runner before this timer or
        // the model's own `timeout` arg ever mattered.
        const timeoutSec = background
          ? typeof args.timeout === "number"
            ? Math.max(1, Math.min(3600, args.timeout))
            : 600
          : typeof args.timeout === "number"
            ? Math.max(1, Math.min(300, args.timeout))
            : 300
        const timeoutMs = timeoutSec * 1000
        const config = ctx.config
        const { shell, shellArgs } = parseShellCommand(config.shellCommand)

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

        // ─── 1b. Auto-Approval Policy (pre-compute before permission check) ───
        const approval = checkAutoApproval(command)
        const isPreApproved = approval === "allow"

        // ─── 2. Permission System Check ───
        if (!isCommandAllowed("bash", command, ctx.permissions)) {
          if (isPreApproved) {
            // Already pre-approved by the auto-approval policy; run it.
          } else {
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
        }

        // ─── 3. Validate Environment (sanitized into the child below) ───
        validateEnv(process.env)

        // ─── 4. Determine Sandbox Type ───
        const perms = ctx.permissions as unknown as Record<string, unknown>
        const sandboxType = detectSandboxType(perms)
        // Mode now selects the FILESYSTEM policy, not the isolator. plan /
        // read-only emit an empty `writableRoots`, which fs-policy defines as
        // deny-all - the direction that makes "read-only" mean something at the
        // OS layer instead of only in the in-process screen.
        const readOnly = isReadOnlyMode(perms)
        const hostPolicy = hostPolicyFromPermissions(perms)
        const networkDisabled = hostPolicy.disableNetwork

        // ─── 4b. Host policy (only meaningful when the network is reachable) ───
        // `allowedDomains`/`blockedDomains` were threaded into every spawn
        // request and consulted by nothing, so a block-list changed no
        // behaviour. This is the check that makes the field mean something.
        //
        // Skipped when the network is already disabled: the kernel has removed
        // the route, so there is nothing left to police and scanning would only
        // risk refusing a command for naming a host it cannot reach.
        if (!networkDisabled && (hostPolicy.allowedDomains.length > 0 || hostPolicy.blockedDomains.length > 0)) {
          const refused = networkViolationForCommand(command, hostPolicy)
          if (refused !== undefined) {
            // Recorded before refusing, so a repeated attempt is visible in the
            // audit trail rather than only in the transcript.
            recordNetworkViolation(refused, "bash", process.pid ?? 0)
            return textResult(
              `Permission denied: ${refused}. Command: ${command}`,
              /*isError*/ true,
            )
          }
        }

        // ─── 5. Filter Environment Variables ───
        let safeEnv = buildBashEnv(process.env, sandboxType, networkDisabled)

        // ─── 5b. Shell-vs-isolator session probe (cached): static checks
        //     cannot see launcher chains like Git's dispatcher stub, so the
        //     first OS run verifies the shell with our own `exit 0`
        //     payload. A failed probe parks the session on the policy path
        //     with truthful child metadata instead of dying on every call. ───
        const osEngaged = shouldUseOsSandbox(sandboxType)
        let osProbe: ShellOsProbe | undefined
        if (osEngaged) {
          osProbe = await probeShellUnderOsSandbox({
            shell,
            shellArgs,
            ctx,
            safeEnv,
            sandboxType,
            networkDisabled,
            spawnFn: deps?.spawnFn,
          })
          if (!osProbe.ok) {
            // The child must not carry OS-sandbox stamps it does not have.
            safeEnv = buildBashEnv(process.env, "policy-only", /*networkDisabled*/ false)
          }
        }

        // ─── 6. Background mode: same checks as foreground, but the job
        //     is handed to the registry and we return its id at once. ───
        if (background) {
          return await startBackgroundJob({
            command,
            shell,
            shellArgs,
            ctx,
            safeEnv,
            timeoutMs,
            timeoutSec,
            sandboxType,
            networkDisabled,
            readOnly,
            spawnFn: deps?.spawnFn,
            osProbe,
          })
        }

        // ─── 7. Execute: OS-isolated when the sandboxSpawn flag engages a
        //     real backend AND the shell survives it, otherwise the
        //     long-standing policy path. ───
        if (osEngaged && osProbe?.ok === true) {
          if (signal?.aborted) return textResult("aborted", /*isError*/ true)
          return runForegroundOsSandboxed({
            shell,
            shellArgs,
            command,
            ctx,
            safeEnv,
            sandboxType,
            networkDisabled,
            timeoutMs,
            timeoutSec,
            signal,
            readOnly,
            spawnFn: deps?.spawnFn,
          })
        }

        // Downgraded from the OS path: the policy-path contract is "no
        // marker where no isolator exists" — but an isolator that was
        // engaged and then refused this shell must say so. Once per
        // process: repeating it on every command is noise, not honesty.
        const downgrade = osEngaged && osProbe !== undefined && !osProbe.ok
          ? claimSandboxDowngrade(osProbe.reason)
          : ""
        const osDowngradeNote = downgrade ? `\n\n[${downgrade}]` : ""

        // ─── 7. Execute Under Sandbox (OS-isolated when engaged, else policy) ───
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

          // ─── Spawn under policy (in-process evaluation) ───
          processManager
            .spawn({
              command: [shell, ...shellArgs, command],
              cwd: ctx.cwd,
              env: safeEnv,
              timeoutMs,
              outputCap: OUTPUT_MAX_BYTES,
              processGroup: true,
              signal,
              // [shell, /c, <raw command>] must reach cmd.exe exactly as
              // typed: CRT-quoting escapes the user's quotes into `\"` and
              // cmd mangles them (`echo "hi"` → `\"hi\"`, `node -e "..."`
              // silently no-ops). A spaced program path (Git's default
              // bash) must NOT be verbatim — see verbatimArgvSafe.
              windowsVerbatimArguments: verbatimArgvSafe(shell),
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
                resolve(textResult(truncated.text + status + osDowngradeNote, isError))
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
