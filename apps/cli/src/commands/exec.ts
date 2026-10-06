/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { execFile } from "node:child_process"
import * as fs from "node:fs"
import { promisify } from "node:util"
import { Agent, loadConfig } from "../../../runtime/src/index.js"
import { EXIT_DENIED, EXIT_ERROR } from "../command-registry.js"

/** Cap piped stdin: a multi-megabyte dump must not blow the context window. */
export const MAX_PIPED_STDIN_CHARS = 100_000

/** Read piped stdin ("" when interactive/closed/unreadable — never blocks,
 *  never throws). A TTY (`isTTY === true`) is never read; pipes *and* the
 *  undefined-isTTY case (Windows pipes, spawned contexts) are attempted —
 *  a closed stdin reads as "" instead of blocking. Exported for tests;
 *  pass explicit args, no real stdin. */
export function readPipedStdin(
  isTTY: boolean | undefined,
  readStdin: () => string = (): string => fs.readFileSync(0, "utf8"),
): string {
  if (isTTY === true) return ""
  try {
    return readStdin()
  } catch {
    return ""
  }
}

/** Instruction first, piped context after — the model reads it as data. */
export function combinePromptWithStdin(prompt: string, piped: string): string {
  const clean = piped.trim()
  if (!clean) return prompt
  const capped =
    clean.length > MAX_PIPED_STDIN_CHARS ? `${clean.slice(0, MAX_PIPED_STDIN_CHARS)}\n…[piped stdin truncated]` : clean
  const block = `[Piped stdin follows:]\n${capped}`
  return prompt ? `${prompt}\n\n${block}` : block
}

/**
 * The shape of an agent event this module inspects.
 *
 * Declared structurally rather than imported from `packages/protocol`, because
 * `apps/cli` may only import `packages/core` and `packages/execpolicy`
 * (`trayambak/no-cross-package-import`). Every `TaggedAgentEvent` satisfies this
 * shape, so the loop's real event stream narrows here unchanged; `allowed` and
 * `passed` are optional only because an event of a different type carries
 * neither, and both are read with an explicit `=== true` so a missing field can
 * never be mistaken for a passing one.
 */
export interface RunSignalEvent {
  readonly type: string
  readonly allowed?: boolean
  readonly passed?: boolean
}

/**
 * Accumulated terminal signals from one headless run. Only failures that change
 * the process's meaning are recorded — a degraded-but-progressing run must not
 * be able to fail a pipeline.
 */
export interface RunSignals {
  /** `permission_response` events where policy said no. */
  denied: number
  /** `permission_response` events where policy said yes. */
  allowed: number
  /** The rollout budget cut the loop short. */
  budgetExhausted: boolean
  /** The loop ran its own checks and they did not pass. */
  verificationFailed: boolean
}

export const NO_RUN_SIGNALS: RunSignals = {
  denied: 0,
  allowed: 0,
  budgetExhausted: false,
  verificationFailed: false,
}

/** Fold one event into the run's signals. Pure, so it is directly testable. */
export function recordRunSignal(signals: RunSignals, event: RunSignalEvent): RunSignals {
  switch (event.type) {
    case "permission_response":
      return event.allowed === true
        ? { ...signals, allowed: signals.allowed + 1 }
        : { ...signals, denied: signals.denied + 1 }
    case "budget_exhausted":
      return { ...signals, budgetExhausted: true }
    case "verification_end":
      return event.passed === true ? signals : { ...signals, verificationFailed: true }
    default:
      return signals
  }
}

/**
 * The status a finished headless run should report, or undefined to leave the
 * exit code alone.
 *
 * `exec` is the CI-facing command, and it used to exit 0 unconditionally: a run
 * in which policy refused every tool call, or one the rollout budget cut short,
 * told the shell it had succeeded while having accomplished nothing. The
 * `EXIT_DENIED` code already existed for precisely this ("the check ran fine,
 * the answer is no — CI-gatable"); only the agent path never consulted it.
 *
 * Deliberately narrow, so ordinary partial noise does not start failing
 * pipelines:
 * - A denial only matters when *nothing at all* was permitted. One refused call
 *   inside an otherwise productive run is a normal conversational turn, not a
 *   failed run.
 * - `budget_exhausted` and a failed `verification_end` are terminal by
 *   construction: the loop stopped early, or reported its own checks failing.
 * - An `mcp_fail` or `subagent_fail` degrades a run rather than failing it, so
 *   neither is recorded here.
 */
export function exitCodeForSignals(signals: RunSignals): number | undefined {
  if (signals.budgetExhausted || signals.verificationFailed) return EXIT_ERROR
  if (signals.denied > 0 && signals.allowed === 0) return EXIT_DENIED
  return undefined
}

/** Headless exec: run one prompt, stream JSON events to stdout (Codex exec parity). */
export async function execCommand(
  prompt: string,
  opts: { model?: string; sessionFile?: string } = {},
  deps: { readStdin?: () => string } = {},
): Promise<void> {
  // deps.readStdin is the test seam: unit tests must never touch real fd 0
  // (a worker with an open-but-quiet stdin blocks forever on read).
  const piped = deps.readStdin ? deps.readStdin() : readPipedStdin(process.stdin.isTTY)
  const full = combinePromptWithStdin(prompt, piped)
  const config = loadConfig(opts.model ? { model: opts.model } : {})
  const agent = new Agent({ config, sessionFile: opts.sessionFile })
  let signals: RunSignals = NO_RUN_SIGNALS
  await agent.run(full, (event) => {
    process.stdout.write(JSON.stringify(event) + "\n")
    signals = recordRunSignal(signals, event)
  })
  // Set only after the stream closes, and never downgrade an existing non-zero
  // code (a throw from the run is reported by main()'s handler).
  const code = exitCodeForSignals(signals)
  if (code !== undefined && (process.exitCode === undefined || process.exitCode === 0)) {
    process.exitCode = code
  }
}

/** Review: ask the agent to review a diff/file context. */
export async function reviewCommand(
  target: string,
  deps: { isRepo?: () => Promise<boolean>; runAgent?: (prompt: string) => Promise<void> } = {},
): Promise<void> {
  const t = target.trim()
  // Default target means "review my uncommitted diff" — outside a repo there
  // is no diff, so fail fast instead of burning a model turn on nothing.
  if (t === "" || /^(current changes|uncommitted)$/i.test(t)) {
    let inside = false
    try {
      inside = await (deps.isRepo ?? defaultIsRepo)()
    } catch {
      inside = false
    }
    if (!inside) {
      process.stdout.write("Not a git repository — pass a file or directory path to review instead.\n")
      process.exitCode = EXIT_ERROR
      return
    }
  }
  await (deps.runAgent ?? execCommand)(
    `Review the following for bugs, security issues, and style: ${target || "current changes"}`,
  )
}

async function defaultIsRepo(): Promise<boolean> {
  const execFileAsync = promisify(execFile)
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { timeout: 10_000 })
    return stdout.trim() === "true"
  } catch {
    return false
  }
}
