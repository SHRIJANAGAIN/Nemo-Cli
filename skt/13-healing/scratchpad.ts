/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"

export type TargetType = "USER_CODE" | "CORE_CONTROLLER"

export interface ScratchpadEntry {
  goal: string
  targetType: TargetType
  knownFacts: string[]
  activeErrors: string[]
  invalidAssumptions: string[]
  proposedPatch: string
  timestamp: string
  bugId?: string
  status: "active" | "completed" | "failed"
  branch?: string
}

const SCRATCHPAD_DIR = ".trayambak"
const SCRATCHPAD_FILE = "agent_scratchpad.md"

function scratchpadDir(): string {
  return path.join(process.cwd(), SCRATCHPAD_DIR)
}

function scratchpadFile(): string {
  return path.join(scratchpadDir(), SCRATCHPAD_FILE)
}

export function ensureScratchpadDir(): void {
  const dir = scratchpadDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function initScratchpad(): void {
  ensureScratchpadDir()
  const file = scratchpadFile()
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      `# Trayambak Agent Scratchpad\n\n_Last initialized: ${new Date().toISOString()}_\n\nNo active tasks.`,
      "utf8",
    )
  }
}

export function updateScratchpad(entry: ScratchpadEntry): void {
  ensureScratchpadDir()
  const file = scratchpadFile()
  const content = formatScratchpad(entry)
  fs.writeFileSync(file, content, "utf8")
}

export function appendAssumption(invalidAssumption: string): void {
  ensureScratchpadDir()
  const file = scratchpadFile()
  if (!fs.existsSync(file)) initScratchpad()
  const existing = fs.readFileSync(file, "utf8")
  const marker = "## INVALID_ASSUMPTIONS\n"
  const updated = existing.includes(marker)
    ? existing.replace(marker, `${marker}- ${invalidAssumption}\n`)
    : `${existing}\n${marker}- ${invalidAssumption}\n`
  fs.writeFileSync(file, updated, "utf8")
}

export function appendError(error: string): void {
  ensureScratchpadDir()
  const file = scratchpadFile()
  if (!fs.existsSync(file)) initScratchpad()
  const existing = fs.readFileSync(file, "utf8")
  const marker = "## ACTIVE_ERRORS\n"
  const updated = existing.includes(marker)
    ? existing.replace(marker, `${marker}- ${error}\n`)
    : `${existing}\n${marker}- ${error}\n`
  fs.writeFileSync(file, updated, "utf8")
}

export function clearScratchpad(): void {
  ensureScratchpadDir()
  const file = scratchpadFile()
  fs.writeFileSync(
    file,
    `# Trayambak Agent Scratchpad\n\n_Last initialized: ${new Date().toISOString()}_\n\nNo active tasks.`,
    "utf8",
  )
}

function formatScratchpad(entry: ScratchpadEntry): string {
  return [
    "# Trayambak Agent Scratchpad",
    "",
    `> Last updated: ${entry.timestamp}`,
    "",
    "## GOAL",
    entry.goal,
    "",
    "## TARGET_TYPE",
    entry.targetType,
    "",
    "## BUG_ID",
    entry.bugId ?? "N/A",
    "",
    "## KNOWN_FACTS",
    ...entry.knownFacts.map((f) => `- ${f}`),
    "",
    "## ACTIVE_ERRORS",
    ...entry.activeErrors.map((e) => `- ${e}`),
    "",
    "## INVALID_ASSUMPTIONS",
    ...entry.invalidAssumptions.map((a) => `- ${a}`),
    "",
    "## PROPOSED_PATCH",
    "```",
    entry.proposedPatch,
    "```",
    "",
    "## STATUS",
    `\`${entry.status}\``,
    ...(entry.branch ? [`\nBranch: ${entry.branch}`] : []),
    "",
  ].join("\n")
}
