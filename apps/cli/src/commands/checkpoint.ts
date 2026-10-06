/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { createCheckpoint, listCheckpoints } from "../../../../packages/checkpoints/src/index.js"
import { EXIT_USAGE } from "../command-registry.js"

export function checkpointCommand(args: string[]): string {
  const [action, sessionId] = args
  if (action === "create" && sessionId) {
    const cp = createCheckpoint(sessionId, process.cwd())
    return `checkpoint ${cp.id} (${cp.files.length} files)`
  }
  if (action === "list" && sessionId) {
    const list = listCheckpoints(sessionId)
    return list.length === 0
      ? "no checkpoints"
      : list.map((c: { id: string; createdAt: number }) => `${c.id} ${new Date(c.createdAt).toISOString()}`).join("\n")
  }
  // Usage errors exit 2 like every other usage error — printing usage text
  // with exit 0 reads as success to every script driving the CLI.
  process.exitCode = EXIT_USAGE
  return "Usage: trayambak checkpoint <create|list> <session-id>"
}
