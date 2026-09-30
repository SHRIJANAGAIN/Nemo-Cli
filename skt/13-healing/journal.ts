/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { TargetType } from "./scratchpad.js"

export interface JournalEntry {
  bugId: string
  targetType: TargetType
  rootCause: string
  verifiedPatch: string
  preventionRule: string
  timestamp: string
  filePath?: string
  lineNumber?: number
  branchUsed?: string
}

const JOURNAL_DIR = ".trayambak"
const JOURNAL_FILE = "self_healing_journal.md"

function journalDir(): string {
  return path.join(process.cwd(), JOURNAL_DIR)
}

function journalFile(): string {
  return path.join(journalDir(), JOURNAL_FILE)
}

export function ensureJournalDir(): void {
  const dir = journalDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function initJournal(): void {
  ensureJournalDir()
  const file = journalFile()
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      "# Trayambak Self-Healing Journal\n\n_Log of all resolved bugs and prevention rules._\n",
      "utf8",
    )
  }
}

export function logHealingEntry(entry: JournalEntry): string {
  ensureJournalDir()
  const file = journalFile()
  if (!fs.existsSync(file)) initJournal()

  const existing = fs.readFileSync(file, "utf8")
  const entryBlock = [
    "",
    `## ${entry.timestamp} — ${entry.bugId}`,
    "- **target_type:** `" + entry.targetType + "`",
    ...(entry.filePath ? ["- **file_path:** `" + entry.filePath + "`"] : []),
    ...(entry.lineNumber ? ["- **line:** " + entry.lineNumber] : []),
    ...(entry.branchUsed ? ["- **branch:** `" + entry.branchUsed + "`"] : []),
    "- **root_cause:** " + entry.rootCause,
    "- **verified_patch:**",
    "```",
    entry.verifiedPatch,
    "```",
    "- **prevention_rule:** " + entry.preventionRule,
  ].join("\n")

  const updated = existing + entryBlock
  fs.writeFileSync(file, updated, "utf8")

  return entryBlock
}

export function getPreventionRules(): string[] {
  const file = journalFile()
  if (!fs.existsSync(file)) return []
  const content = fs.readFileSync(file, "utf8")
  const rules = content
    .split("\n")
    .filter((line) => line.startsWith("- **prevention_rule:**"))
    .map((line) => line.replace("- **prevention_rule:** ", "").trim())
  return rules
}

export function getPreventionRulesForTarget(targetType: TargetType): string[] {
  const file = journalFile()
  if (!fs.existsSync(file)) return []
  const content = fs.readFileSync(file, "utf8")
  const sections = content.split("## ")
  const rules: string[] = []

  for (const section of sections) {
    if (!section.includes(targetType)) continue
    const ruleMatch = section.match(/\*\*prevention_rule:\*\*\s*(.+)/)
    if (ruleMatch) {
      rules.push(ruleMatch[1].trim())
    }
  }

  return rules
}
