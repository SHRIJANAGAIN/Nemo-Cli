/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Agent, loadConfig } from "../../../runtime/src/index.js"
import type { AgentEvent, AgentMessage } from "../../../../packages/protocol/src/index.js"
import { failOutput } from "../command-registry.js"

const execFileAsync = promisify(execFile)

/** Bytes of diff sent to the model — a full monorepo dump would drown it. */
export const COMMIT_DIFF_CAP = 12_000

export type DiffRunner = (args: string[], cwd: string) => Promise<string>

const defaultRunner: DiffRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

/** Staged (default) or working-tree diff, capped. Pure apart from `run`. */
export async function getStagedDiff(
  mode: "staged" | "all",
  cwd: string,
  run: DiffRunner = defaultRunner,
): Promise<{ ok: true; diff: string } | { ok: false; error: string }> {
  let raw: string
  try {
    raw = mode === "all" ? await run(["diff", "--", "."], cwd) : await run(["diff", "--staged", "--", "."], cwd)
  } catch (error) {
    // execFile surfaces git's raw stderr (often a full usage dump): distill
    // it to the first meaningful line, with a plain-English note for the
    // common "ran outside a repo" case.
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : ""
    const text = stderr.trim() || (error instanceof Error ? error.message : String(error))
    if (/not a git repository/i.test(stderr)) {
      return { ok: false, error: "not a git repository — run inside one or pass --cwd <repo>" }
    }
    const first = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "git diff failed"
    return { ok: false, error: `git diff failed: ${first.slice(0, 200)}` }
  }
  if (!raw.trim()) {
    return {
      ok: false,
      error: mode === "all" ? "no working-tree changes" : "nothing staged (git add first, or use --all)",
    }
  }
  const diff = raw.length > COMMIT_DIFF_CAP ? raw.slice(0, COMMIT_DIFF_CAP) + "\n…[diff truncated]" : raw
  return { ok: true, diff }
}

/** Conventional-commit instruction carrying the diff. Pure. */
export function buildCommitPrompt(diff: string): string {
  return (
    "Write a conventional-commit message for the diff below. " +
    "Rules: <type>(<scope>): <subject> on line 1 (≤72 chars), blank line, then a short body. " +
    "Output ONLY the message, no fences, no explanation.\n\nDiff:\n" +
    diff
  )
}

/** Last assistant text of a run — the commit message. Pure. */
export function pickFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== "assistant") continue
    const text = message.content.find((part) => part.type === "text")
    if (text && "text" in text && text.text.trim().length > 0) return text.text.trim()
  }
  return ""
}

export type AgentRunner = (prompt: string) => Promise<AgentMessage[]>

const defaultAgentRunner: AgentRunner = async (prompt) => {
  const agent = new Agent({ config: loadConfig({}) })
  const events: AgentEvent[] = []
  const messages = await agent.run(prompt, async (event) => {
    events.push(event)
  })
  void events
  return messages
}

/** `trayambak commit`: model-drafted conventional-commit message for the diff. */
export async function commitCommand(
  opts: { mode?: "staged" | "all"; cwd?: string },
  deps: { runDiff?: DiffRunner; runAgent?: AgentRunner } = {},
): Promise<string> {
  const cwd = opts.cwd ?? process.cwd()
  const mode = opts.mode ?? "staged"
  const got = await getStagedDiff(mode, cwd, deps.runDiff)
  if (!got.ok) return failOutput(`Error: ${got.error}`)
  const runAgent = deps.runAgent ?? defaultAgentRunner
  const messages = await runAgent(buildCommitPrompt(got.diff))
  const text = pickFinalText(messages)
  return text.length > 0 ? text : failOutput("Error: the agent produced no commit message")
}
