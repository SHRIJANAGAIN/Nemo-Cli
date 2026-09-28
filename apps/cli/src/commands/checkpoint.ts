/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { createCheckpoint, listCheckpoints } from "../../../../packages/checkpoints/src/index.js"

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
  return "Usage: trayambak checkpoint <create|list> <session-id>"
}
