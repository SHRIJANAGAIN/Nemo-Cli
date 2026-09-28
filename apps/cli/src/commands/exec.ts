/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { Agent, loadConfig } from "../../../runtime/src/index.js"

/** Headless exec: run one prompt, stream JSON events to stdout (Codex exec parity). */
export async function execCommand(prompt: string, opts: { model?: string } = {}): Promise<void> {
  const config = loadConfig(opts.model ? { model: opts.model } : {})
  const agent = new Agent({ config })
  await agent.run(prompt, (event) => {
    process.stdout.write(JSON.stringify(event) + "\n")
  })
}

/** Review: ask the agent to review a diff/file context. */
export async function reviewCommand(target: string): Promise<void> {
  await execCommand(`Review the following for bugs, security issues, and style: ${target || "current changes"}`)
}
