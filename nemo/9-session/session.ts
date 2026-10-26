/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import { spawn, type ChildProcess } from "child_process"
import * as path from "path"
import { assertSessionId } from "../../packages/core/src/validate.js"

/**
 * Every `sessionId` handled below names a directory under `sessionsDir()`, and
 * each of these four functions then does something destructive with it: a
 * recursive `rmSync`, a `mkdirSync` plus append, a full-file rewrite, or a read.
 *
 * `nemo/8-conversations/sessions.json` is a plain JSON file, so a poisoned entry
 * (`{"sessionId":"../../../src"}`) turned the TUI session picker's delete —
 * which imports `deleteSession` straight from this module — into an arbitrary
 * directory delete, and the log helpers into arbitrary file append and read.
 * Validate once at each entry point, and fail closed without throwing so no
 * caller's return contract changes.
 *
 * Uses core's canonical rule rather than a second copy of the regex that could
 * drift from `packages/session-backends` and the CLI's archive command.
 */
function usableSessionId(sessionId: string): boolean {
  try {
    assertSessionId(sessionId)
    return true
  } catch {
    return false
  }
}

declare const __dirname: string

/** Stable identifier for a session (branded alias for readability). */
export type SessionId = string

export interface SessionEntry {
  sessionId: string
  sessionName: string
  sessionDescription: string
  startedAt: string
  endedAt?: string
  messageCount: number
  totalTokens: number
  status: "active" | "completed" | "abandoned"
}

function projectRoot(): string {
  if (process.env.NEMO_HOME && fs.existsSync(path.join(process.env.NEMO_HOME, "package.json"))) {
    return process.env.NEMO_HOME
  }
  let dir = __dirname
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function sessionsDir(): string {
  const root = projectRoot()
  const candidate = path.join(root, "nemo", "8-conversations")
  try {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
  } catch {
    // fall through to cwd
  }
  return path.join(process.cwd(), "nemo", "8-conversations")
}

function sessionsFile(): string {
  return path.join(sessionsDir(), "sessions.json")
}

export function loadSessions(): SessionEntry[] {
  try {
    if (!fs.existsSync(sessionsFile())) return []
    return JSON.parse(fs.readFileSync(sessionsFile(), "utf8")) as SessionEntry[]
  } catch {
    return []
  }
}

export function saveSessions(entries: SessionEntry[]): void {
  fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true })
  fs.writeFileSync(sessionsFile(), JSON.stringify(entries, null, 2), "utf8")
}

export function createSession(name: string, description: string): SessionEntry {
  const entry: SessionEntry = {
    sessionId: `sess_${Date.now().toString(36)}`,
    sessionName: name,
    sessionDescription: description,
    startedAt: new Date().toISOString(),
    messageCount: 0,
    totalTokens: 0,
    status: "active",
  }
  const all = loadSessions()
  all.push(entry)
  saveSessions(all)
  return entry
}

export function renameSession(sessionId: string, name: string, description?: string): void {
  const all = loadSessions()
  const session = all.find((entry) => entry.sessionId === sessionId)
  if (!session) return
  session.sessionName = name
  if (description) session.sessionDescription = description
  saveSessions(all)
}

export function getActiveSession(): SessionEntry | null {
  return loadSessions().find((s) => s.status === "active") ?? null
}

export function archiveSession(sessionId: string): boolean {
  const all = loadSessions()
  const s = all.find((x) => x.sessionId === sessionId)
  if (!s) return false
  s.status = "abandoned"
  s.endedAt = new Date().toISOString()
  saveSessions(all)
  return true
}

export function unarchiveSession(sessionId: string): boolean {
  const all = loadSessions()
  const s = all.find((x) => x.sessionId === sessionId)
  if (!s) return false
  s.status = "active"
  s.endedAt = undefined
  saveSessions(all)
  return true
}

export function searchSessions(query: string): SessionEntry[] {
  const all = loadSessions()
  if (!query.trim()) return all
  const lower = query.toLowerCase()
  return all.filter(
    (s) =>
      s.sessionName.toLowerCase().includes(lower) ||
      s.sessionDescription.toLowerCase().includes(lower) ||
      s.sessionId.toLowerCase().includes(lower),
  )
}

export function filterSessions(
  sessions: SessionEntry[],
  filter: { status?: "active" | "completed" | "abandoned" | "all"; cwd?: string },
): SessionEntry[] {
  return sessions.filter((s) => {
    if (filter.status && filter.status !== "all" && s.status !== filter.status) return false
    return true
  })
}

export function sortSessions(
  sessions: SessionEntry[],
  sort: "updated" | "created" | "name" | "messages",
): SessionEntry[] {
  const sorted = [...sessions]
  switch (sort) {
    case "created":
      sorted.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      break
    case "name":
      sorted.sort((a, b) => a.sessionName.localeCompare(b.sessionName))
      break
    case "messages":
      sorted.sort((a, b) => b.messageCount - a.messageCount)
      break
    case "updated":
    default:
      sorted.sort((a, b) => {
        const aTime = new Date(a.endedAt ?? a.startedAt).getTime()
        const bTime = new Date(b.endedAt ?? b.startedAt).getTime()
        return bTime - aTime
      })
      break
  }
  return sorted
}

export function listSessions(
  options: {
    query?: string
    status?: "active" | "completed" | "abandoned" | "all"
    sort?: "updated" | "created" | "name" | "messages"
    limit?: number
    offset?: number
  } = {},
): { sessions: SessionEntry[]; total: number } {
  let all = loadSessions()
  if (options.query) all = searchSessions(options.query)
  if (options.status) all = filterSessions(all, { status: options.status })
  if (options.sort) all = sortSessions(all, options.sort)
  const total = all.length
  if (options.limit) {
    const offset = options.offset ?? 0
    all = all.slice(offset, offset + options.limit)
  }
  return { sessions: all, total }
}

export function endSession(sessionId: string): void {
  const all = loadSessions()
  const s = all.find((x) => x.sessionId === sessionId)
  if (s) {
    s.status = "completed"
    s.endedAt = new Date().toISOString()
  }
  saveSessions(all)
}

export function deleteSession(sessionId: string): boolean {
  if (!usableSessionId(sessionId)) return false
  try {
    const all = loadSessions()
    const filtered = all.filter((x) => x.sessionId !== sessionId)
    saveSessions(filtered)
    const dir = path.join(sessionsDir(), sessionId)
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    return true
  } catch {
    return false
  }
}

export interface ConversationEntry {
  role: "user" | "assistant" | "system" | "tool"
  content: string
  ts: string
  /** Display text for UI restores: when a pasted block rode the composer as
   *  `[Pasted Content N chars]`, the log keeps the FULL text in `content`
   *  (model context stays complete) while `display` holds the collapsed
   *  block the transcript showed. Absent for every other row. */
  display?: string
  toolCallId?: string
  toolName?: string
  toolStatus?: "running" | "completed" | "error"
  thinking?: string
  // Tool outcome, filled when the call finishes (updateConversationToolResult).
  // Was missing entirely: tool rows were persisted only at START, so a
  // resumed session showed every tool call with args but no result, no
  // ✓/✗ fidelity, no durations.
  result?: string
  isError?: boolean
  durationMs?: number
}

export interface ToolResultPatch {
  result?: string
  isError?: boolean
  durationMs?: number
  toolStatus?: "running" | "completed" | "error"
}

/** Default name given to fresh sessions before the first exchange. */
export const DEFAULT_SESSION_NAME = "New conversation"

/**
 * Derive a ≤5-word title from a restored transcript (first user message).
 * Used on resume so sessions stuck at the default name get a real title
 * without waiting for a provider round-trip.
 */
export function titleFromConversation(history: ConversationEntry[]): string {
  const first = history.find((e) => e.role === "user" && (e.content ?? "").trim().length > 0)
  const title = (first?.content ?? "").replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ")
  return title
}

/**
 * Rename every default-named session that already has transcript content,
 * using its own first user message. Returns the fresh entry list.
 * Runs when the resume picker opens so the list never shows stale
 * "New conversation" rows. User-chosen names are never touched.
 */
export function backfillUntitledSessions(): SessionEntry[] {
  try {
    const all = loadSessions()
    let changed = false
    for (const s of all) {
      if (s.sessionName !== DEFAULT_SESSION_NAME) continue
      if ((s.messageCount ?? 0) <= 0) continue
      const title = titleFromConversation(loadConversation(s.sessionId))
      if (!title || title === DEFAULT_SESSION_NAME) continue
      s.sessionName = title
      changed = true
    }
    if (changed) saveSessions(all)
    return changed ? loadSessions() : all
  } catch {
    return loadSessions()
  }
}

export function appendConversation(
  sessionId: string,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
  extra?: {
    toolCallId?: string
    toolName?: string
    toolStatus?: "running" | "completed" | "error"
    thinking?: string
    result?: string
    isError?: boolean
    durationMs?: number
    display?: string
  },
): void {
  if (!usableSessionId(sessionId)) return
  try {
    const dir = path.join(sessionsDir(), sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "log.jsonl")
    const entry: ConversationEntry = { role, content: content.slice(0, 50000), ts: new Date().toISOString(), ...extra }
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8")
    const all = loadSessions()
    const s = all.find((x) => x.sessionId === sessionId)
    if (s) {
      s.messageCount = (s.messageCount ?? 0) + 1
      saveSessions(all)
    }
  } catch (err) {
    console.error(`Failed to append conversation for session ${sessionId}:`, err)
  }
}

/**
 * Session-lifecycle notices are UI chrome for the moment they fire — they
 * are NOT conversation history. Older builds persisted them into
 * log.jsonl, so a session resumed N times restored N stale
 * "Resumed session: ..." banners wedged mid-transcript (resume
 * duplication bug). New writes skip them (App's
 * addMessage({ persist: false })); this read-side filter also cleans up
 * sessions that were already polluted.
 */
const TRANSIENT_NOTICE_RE =
  /^(?:Resumed session:|New conversation started\.|Archived session:|Renamed session |Deleted session:|Forked "|Agent selected:)/

/** True for a transient session-lifecycle system notice (never history). */
export function isTransientNotice(content: string): boolean {
  return TRANSIENT_NOTICE_RE.test(content.trim())
}

/**
 * Fill in a tool call's outcome on its START row (matched by toolCallId,
 * LAST match wins): tool_execution_end only updated React state, so results
 * never reached the log and resumed sessions lost every tool output. The
 * log stays append-ordered — the row is patched in place, never duplicated.
 * Only defined patch fields are written; everything else passes through.
 */
export function updateConversationToolResult(sessionId: string, toolCallId: string, patch: ToolResultPatch): void {
  if (!usableSessionId(sessionId)) return
  try {
    const file = path.join(sessionsDir(), sessionId, "log.jsonl")
    if (!fs.existsSync(file)) return
    const raw = fs.readFileSync(file, "utf8")
    const lines = raw.split("\n")
    let updated = false
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].trim()) continue
      try {
        const parsed = JSON.parse(lines[i]) as ConversationEntry
        if (parsed.toolCallId === toolCallId) {
          const next: ConversationEntry = { ...parsed }
          if (patch.result !== undefined) next.result = patch.result.slice(0, 50000)
          if (patch.isError !== undefined) next.isError = patch.isError
          if (patch.durationMs !== undefined) next.durationMs = patch.durationMs
          if (patch.toolStatus !== undefined) next.toolStatus = patch.toolStatus
          lines[i] = JSON.stringify(next)
          updated = true
          break
        }
      } catch {
        /* keep unparseable lines as-is */
      }
    }
    if (updated) fs.writeFileSync(file, lines.join("\n"), "utf8")
  } catch (err) {
    console.error(`Failed to update tool result for session ${sessionId}:`, err)
  }
}

export function loadConversation(sessionId: string): ConversationEntry[] {
  if (!usableSessionId(sessionId)) return []
  try {
    const file = path.join(sessionsDir(), sessionId, "log.jsonl")
    if (!fs.existsSync(file)) return []
    const raw = fs.readFileSync(file, "utf8")
    const lines = raw.split("\n").filter((l) => l.trim())
    const entries: ConversationEntry[] = []
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as ConversationEntry
        if (["user", "assistant", "system", "tool"].includes(parsed.role)) {
          // Drop stale lifecycle chrome restored from older (polluted)
          // session logs — see TRANSIENT_NOTICE_RE.
          if (parsed.role === "system" && isTransientNotice(parsed.content ?? "")) continue
          entries.push(parsed)
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return entries
  } catch {
    return []
  }
}

export function getSessionReport(): string {
  const sessions = loadSessions()
  const active = sessions.filter((s) => s.status === "active").length
  const completed = sessions.filter((s) => s.status === "completed").length
  return [
    `NEMO SESSION REPORT`,
    `Total Sessions: ${sessions.length}`,
    `Active: ${active} | Completed: ${completed}`,
    `Last: ${sessions[sessions.length - 1]?.sessionName ?? "none"}`,
  ].join("\n")
}

/**
 * Voice input support: tries platform-native speech-to-text.
 * Windows: PowerShell SpeechRecognition (if available).
 * macOS: `shortcuts` or `say` + external STT.
 * Falls back to typing if no STT engine is available.
 */
export async function captureVoiceInput(timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    let voiceChild: ChildProcess | null = null
    const done = (text: string) => {
      if (settled) return
      settled = true
      voiceChild?.kill("SIGTERM")
      resolve(text.trim())
    }

    if (process.platform === "win32") {
      // Use PowerShell's built-in SpeechRecognition via .NET
      const psScript = `
Add-Type -AssemblyName System.Speech
$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$rec.SetInputToDefaultAudioDevice()
$grammar = New-Object System.Speech.Recognition.DictationGrammar
$rec.LoadGrammar($grammar)
$rec.RecognizeAsync("Stop")
$result = $rec.Recognize([TimeSpan]::FromSeconds(${Math.ceil(timeoutMs / 1000)}))
if ($result) { Write-Output $result.Text }
`
      voiceChild = spawn("powershell.exe", ["-NoProfile", "-Command", psScript], {
        timeout: timeoutMs + 5000,
        windowsHide: true,
      })
      let buf = ""
      voiceChild.stdout?.on("data", (d) => (buf += d.toString()))
      voiceChild.on("close", () => done(buf || ""))
      voiceChild.on("error", () => done(""))
    } else {
      done("")
    }
    setTimeout(() => done(""), timeoutMs)
  })
}
