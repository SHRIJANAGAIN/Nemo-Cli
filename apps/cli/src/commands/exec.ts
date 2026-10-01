/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import * as fs from "node:fs"
import { Agent, loadConfig } from "../../../runtime/src/index.js"

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

/** Headless exec: run one prompt, stream JSON events to stdout (Codex exec parity). */
export async function execCommand(prompt: string, opts: { model?: string } = {}): Promise<void> {
  const full = combinePromptWithStdin(prompt, readPipedStdin(process.stdin.isTTY))
  const config = loadConfig(opts.model ? { model: opts.model } : {})
  const agent = new Agent({ config })
  await agent.run(full, (event) => {
    process.stdout.write(JSON.stringify(event) + "\n")
  })
}

/** Review: ask the agent to review a diff/file context. */
export async function reviewCommand(target: string): Promise<void> {
  await execCommand(`Review the following for bugs, security issues, and style: ${target || "current changes"}`)
}
