/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"
import { loadMistakes } from "./1-errors/mistake.js"
import { getInstructionsContextBlock } from "./3-user/instructions.js"
import { getContextBlock } from "./4-mem/memory.js"

const NEMO_DIR = (): string => path.join(process.cwd(), "nemo")

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

export function getNemoContextBlock(): string {
  const nemo = NEMO_DIR()
  const blocks: string[] = []

  const pointsMd = readMdSafe(path.join(nemo, "0-points", "points.md"))
  if (pointsMd) blocks.push(`## Points system:\n${pointsMd.slice(0, 500)}`)

  const errorsMd = readMdSafe(path.join(nemo, "1-errors", "IMPROVEMENT.MD"))
  if (errorsMd) blocks.push(`## Error patterns:\n${errorsMd.slice(0, 500)}`)

  const frameworkMd = readMdSafe(path.join(nemo, "1-errors", "FRAMEWORK.MD"))
  if (frameworkMd) blocks.push(`## Self-Improvement Framework:\n${frameworkMd.slice(0, 800)}`)

  const preventionBlock = readMistakePreventionBlock()
  if (preventionBlock) blocks.push(preventionBlock)

  const instructions = getInstructionsContextBlock()
  if (instructions) blocks.push(instructions)

  const memory = getContextBlock()
  if (memory) blocks.push(memory)

  const evalMd = readMdSafe(path.join(nemo, "5-eval", "EVALS.MD"))
  if (evalMd) blocks.push(`## Evaluation criteria:\n${evalMd.slice(0, 500)}`)

  const historyMd = readMdSafe(path.join(nemo, "6-u", "HISTORY.MD"))
  if (historyMd) blocks.push(`## User history:\n${historyMd.slice(0, 500)}`)

  const cliMd = readMdSafe(path.join(nemo, "7-cli", "CLI.MD"))
  if (cliMd) blocks.push(`## CLI guidelines:\n${cliMd.slice(0, 500)}`)

  const sessions = readJsonSafe(path.join(nemo, "8-conversations", "sessions.json"))
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

  const uiMd = readMdSafe(path.join(nemo, "11-ui", "last-response.txt"))
  if (uiMd) blocks.push(`## UI state:\n${uiMd.slice(0, 500)}`)

  const controlMd = readMdSafe(path.join(nemo, "12-control", "content-control.ts"))
  if (controlMd) blocks.push(`## Content control:\n${controlMd.slice(0, 500)}`)

  if (blocks.length === 0) return ""
  return ["## Nemo Context:", ...blocks].join("\n\n")
}
