/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { loadMistakes } from "./1-errors/mistake.js"
import { getInstructionsContextBlock } from "./3-user/instructions.js"
import { getContextBlock } from "./4-mem/memory.js"

const SKT_DIR = (): string => path.join(process.cwd(), "skt")

function readJsonSafe(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function readMdSafe(file: string): string {
  try {
    if (!fs.existsSync(file)) return ""
    return fs.readFileSync(file, "utf8").trim()
  } catch {
    return ""
  }
}

function readMistakePreventionBlock(): string {
  try {
    const mistakes = loadMistakes() as Array<{
      errorName: string
      howToResolve: string
      futurePrevention: string
      isFixed: boolean
      willRepeatInFuture: boolean
    }>
    const flagged = mistakes.filter((m) => !m.isFixed && m.willRepeatInFuture && m.futurePrevention)
    if (flagged.length === 0) return ""
    const lines = flagged.map((m) => `- **Avoid ${m.errorName}**: ${m.futurePrevention || m.howToResolve}`)
    return `## Mistake Prevention:\nNever repeat these mistakes:\n${lines.join("\n")}`
  } catch {
    return ""
  }
}

export function getSktContextBlock(): string {
  const skt = SKT_DIR()
  const blocks: string[] = []

  const pointsMd = readMdSafe(path.join(skt, "0-points", "points.md"))
  if (pointsMd) blocks.push(`## Points system:\n${pointsMd.slice(0, 500)}`)

  const errorsMd = readMdSafe(path.join(skt, "1-errors", "IMPROVEMENT.MD"))
  if (errorsMd) blocks.push(`## Error patterns:\n${errorsMd.slice(0, 500)}`)

  const frameworkMd = readMdSafe(path.join(skt, "1-errors", "FRAMEWORK.MD"))
  if (frameworkMd) blocks.push(`## Self-Improvement Framework:\n${frameworkMd.slice(0, 800)}`)

  const preventionBlock = readMistakePreventionBlock()
  if (preventionBlock) blocks.push(preventionBlock)

  const pentesterMd = readMdSafe(path.join(skt, "2-pentester", "SKT.MD"))
  if (pentesterMd) blocks.push(`## Pentester guidelines:\n${pentesterMd.slice(0, 500)}`)

  const instructions = getInstructionsContextBlock()
  if (instructions) blocks.push(instructions)

  const memory = getContextBlock()
  if (memory) blocks.push(memory)

  const evalMd = readMdSafe(path.join(skt, "5-eval", "EVALS.MD"))
  if (evalMd) blocks.push(`## Evaluation criteria:\n${evalMd.slice(0, 500)}`)

  const historyMd = readMdSafe(path.join(skt, "6-u", "HISTORY.MD"))
  if (historyMd) blocks.push(`## User history:\n${historyMd.slice(0, 500)}`)

  const cliMd = readMdSafe(path.join(skt, "7-cli", "CLI.MD"))
  if (cliMd) blocks.push(`## CLI guidelines:\n${cliMd.slice(0, 500)}`)

  const sessions = readJsonSafe(path.join(skt, "8-conversations", "sessions.json"))
  if (sessions) {
    const recent: unknown[] = Array.isArray(sessions) ? sessions.slice(-3) : []
    if (recent.length > 0) {
      const lines = recent.map((entry) => {
        const s = entry as Record<string, unknown>
        const id = String(s.id || s.sessionName || "session")
        const summary = String(s.summary || s.title || "")
        return `  - ${id}: ${summary.slice(0, 100)}`
      })
      blocks.push(`## Recent sessions:\n${lines.join("\n")}`)
    }
  }

  const uploadMd = readMdSafe(path.join(skt, "10-upload", "upload.md"))
  if (uploadMd) blocks.push(`## Upload guidelines:\n${uploadMd.slice(0, 500)}`)

  const uiMd = readMdSafe(path.join(skt, "11-ui", "last-response.txt"))
  if (uiMd) blocks.push(`## UI state:\n${uiMd.slice(0, 500)}`)

  const controlMd = readMdSafe(path.join(skt, "12-control", "content-control.ts"))
  if (controlMd) blocks.push(`## Content control:\n${controlMd.slice(0, 500)}`)

  if (blocks.length === 0) return ""
  return ["## SKT Context:", ...blocks].join("\n\n")
}
