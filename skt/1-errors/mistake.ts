/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import path from "path"
import { redactEmbeddedSecrets } from "../../packages/core/src/secrets.js"

declare const __dirname: string

export type ErrorSeverity = "low" | "medium" | "high" | "critical"

export interface MistakeEntry {
  errorId: string
  errorName: string
  errorDescription: string
  errorParagraph: string
  timestamp: string
  userInput: string
  assistantOutput: string
  tokensConsumed: number
  whyAssistantDidIt: string
  reasonItHeld: string
  isUserMistake: boolean
  isAssistantMistake: boolean
  isDeviceError: boolean
  howToResolve: string
  isFixed: boolean
  willRepeatInFuture: boolean
  isRepeated: boolean
  futurePrevention: string
}

/**
 * The mistake journal is USER STATE, not project data. It now lives in
 * the per-user state dir (~/.trayambak/skt/1-errors, overridable with
 * TRAYAMBAK_STATE_DIR) so an installed CLI never writes into the user's
 * project directory or into node_modules.
 *
 * Legacy locations (cwd/skt/1-errors and the package dir) are still
 * READ — and migrated forward once — so existing journals keep working.
 */
function stateErrorsDir(): string {
  const override = process.env.TRAYAMBAK_STATE_DIR
  if (override) return path.join(override, "skt", "1-errors")
  return path.join(os.homedir(), ".trayambak", "skt", "1-errors")
}

function legacyErrorDirs(): string[] {
  return [path.join(process.cwd(), "skt", "1-errors"), __dirname]
}

function readJournalFile(file: string): MistakeEntry[] | null {
  try {
    if (!fs.existsSync(file)) return null
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
    if (Array.isArray(data)) return data as MistakeEntry[]
    if (data && typeof data === "object" && "mistakes" in data && Array.isArray(data.mistakes)) {
      return data.mistakes as MistakeEntry[]
    }
    return null
  } catch {
    return null
  }
}

function mistakesFile(): string {
  return path.join(stateErrorsDir(), "mistakes.json")
}

export function loadMistakes(): MistakeEntry[] {
  const stateFile = mistakesFile()
  const current = readJournalFile(stateFile)
  if (current && current.length > 0) return current

  // Migration: adopt a legacy journal (read-only) exactly once so the
  // developer's historical self-improvement data is not lost.
  if (!current) {
    for (const legacyDir of legacyErrorDirs()) {
      const legacy = readJournalFile(path.join(legacyDir, "mistakes.json"))
      if (legacy && legacy.length > 0) {
        try {
          fs.mkdirSync(stateErrorsDir(), { recursive: true })
          fs.writeFileSync(stateFile, JSON.stringify(legacy, null, 2), "utf8")
        } catch {
          /* read-only legacy data still served below */
        }
        return legacy
      }
    }
  }
  return current ?? []
}

export function saveMistakes(entries: MistakeEntry[]): void {
  const dir = stateErrorsDir()
  fs.mkdirSync(dir, { recursive: true })
  try {
    const existing = readJournalFile(mistakesFile())
    if (existing) {
      fs.writeFileSync(
        mistakesFile(),
        JSON.stringify({ mistakes: entries, lastUpdated: new Date().toISOString() }, null, 2),
        "utf8",
      )
    } else {
      fs.writeFileSync(mistakesFile(), JSON.stringify(entries, null, 2), "utf8")
    }
  } catch {
    fs.writeFileSync(mistakesFile(), JSON.stringify(entries, null, 2), "utf8")
  }
}

export function isRepeatedMistake(errorName: string): boolean {
  return loadMistakes().some((m) => m.errorName === errorName && !m.isFixed)
}

export function getWillRepeatMistakes(): MistakeEntry[] {
  return loadMistakes().filter((m) => !m.isFixed && m.willRepeatInFuture)
}

export function markWillRepeat(errorId: string, note: string): MistakeEntry | null {
  const all = loadMistakes()
  const m = all.find((x) => x.errorId === errorId)
  if (m) {
    m.willRepeatInFuture = true
    m.futurePrevention = (m.futurePrevention + "\n" + note).trim()
    saveMistakes(all)
    return m
  }
  return null
}

export function logMistake(
  errorName: string,
  errorDescription: string,
  errorParagraph: string,
  userInput: string,
  assistantOutput: string,
  tokensConsumed: number,
  whyAssistantDidIt: string,
  reasonItHeld: string,
  isUserMistake: boolean,
  isAssistantMistake: boolean,
  isDeviceError: boolean,
  howToResolve: string,
  futurePrevention = "",
): MistakeEntry {
  const repeated = isRepeatedMistake(errorName)
  // Free-text fields can carry pasted keys (URLs, Bearer tokens) — redact
  // embedded key patterns before anything touches disk (prose preserved).
  const safe = (s: string, cap: number): string => redactEmbeddedSecrets(s).slice(0, cap)
  const entry: MistakeEntry = {
    errorId: `err_${Date.now().toString(36)}`,
    errorName,
    errorDescription,
    errorParagraph,
    timestamp: new Date().toISOString(),
    userInput: safe(userInput, 1000),
    assistantOutput: safe(assistantOutput, 2000),
    tokensConsumed,
    whyAssistantDidIt,
    reasonItHeld,
    isUserMistake,
    isAssistantMistake,
    isDeviceError,
    howToResolve,
    isFixed: false,
    willRepeatInFuture: false,
    isRepeated: repeated,
    futurePrevention: futurePrevention.slice(0, 1000),
  }
  const all = loadMistakes()
  all.push(entry)
  saveMistakes(all)
  return entry
}

export function markFixed(errorId: string, futurePrevention = ""): void {
  const all = loadMistakes()
  const m = all.find((x) => x.errorId === errorId)
  if (m) {
    m.isFixed = true
    if (futurePrevention) m.futurePrevention = futurePrevention
  }
  saveMistakes(all)
}

export function getMistakesReport(): string {
  const entries = loadMistakes()
  const fixed = entries.filter((e) => e.isFixed).length
  const unfixed = entries.filter((e) => !e.isFixed).length
  const repeated = entries.filter((e) => e.isRepeated).length
  return [
    `TRAYAMBAK ERROR REPORT`,
    `Total Mistakes: ${entries.length}`,
    `Fixed: ${fixed} | Unfixed: ${unfixed} | Repeated: ${repeated}`,
    `Recent: ${
      entries
        .slice(-3)
        .map((e) => `${e.errorName} (${e.isFixed ? "FIXED" : "OPEN"})`)
        .join(", ") || "none"
    }`,
  ].join("\n")
}
