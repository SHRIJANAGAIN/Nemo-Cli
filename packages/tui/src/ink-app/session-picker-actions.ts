/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * SessionPicker action handlers, extracted from App.tsx's inline JSX so the
 * resume / archive / rename / delete / fork / new-chat flows are unit
 * testable without mounting the 4000-line component
 * (session-picker-actions.test.ts).
 *
 * State accessors arrive as dependencies (refs + setters the component owns);
 * session IO comes from the session store directly — tests mock those
 * modules. Bodies are byte-identical to the inline versions they replace.
 */
import {
  appendConversation,
  archiveSession,
  createSession,
  deleteSession,
  loadConversation,
  renameSession,
  titleFromConversation,
  DEFAULT_SESSION_NAME,
  type SessionEntry,
} from "../../../../nemo/9-session/session.js"
import { restoreMessages } from "./restore-messages.js"
import type { NemoMessage } from "./types.js"

/** The slice of App state these handlers close over. */
export interface SessionPickerState {
  setShowPicker: (open: boolean) => void
  sessionIdRef: { current: string | null }
  currentSessionRef: { current: SessionEntry | null }
  setMessages: (messages: NemoMessage[]) => void
  setStaticEpoch: (update: (epoch: number) => number) => void
  addSystemMessage: (content: string, opts?: { persist?: boolean; ttlMs?: number }) => string
  /** Hand the resumed transcript to the agent: it seeds the agent session and
   *  refreshes the system prompt, so the resumed chat carries its history and
   *  the current long-term memory instead of starting blank. */
  onSessionResumed?: (restored: NemoMessage[]) => void
  /** How many long-term memories the store holds — shown in the banner. */
  memoryCount?: () => number
}

export const createSessionPickerActions = (state: SessionPickerState) => ({
  onSelect: (session: SessionEntry): void => {
    state.setShowPicker(/*showPicker*/ false)
    // Re-picking the session already on screen is a no-op:
    // reloading would replace LIVE state with log.jsonl, which
    // lags it (assistant replies persist only on message_end) —
    // dropping the in-flight turn and stacking another resume
    // banner (resume duplication bug).
    if (state.sessionIdRef.current === session.sessionId) return
    state.sessionIdRef.current = session.sessionId
    state.currentSessionRef.current = session
    const history = loadConversation(session.sessionId)
    // Backfill: sessions stuck at the default name (titled before
    // auto-title existed, or a failed title call) get a real title
    // from their own first user message on resume — deterministic,
    // no provider round-trip. A user-chosen name is never touched.
    if (session.sessionName === DEFAULT_SESSION_NAME) {
      const backfill = titleFromConversation(history)
      if (backfill) {
        renameSession(session.sessionId, backfill)
        session.sessionName = backfill
        state.currentSessionRef.current = { ...session }
      }
    }
    // Rebuild live-shaped messages from the persisted pair: each
    // tool call is logged as an args-only assistant row PLUS a tool
    // row carrying id/result — restoring the raw pair rendered junk
    // (`{"command":…}` text + a `✓ tool — {…}` one-liner with the
    // result invisible) instead of the live "Called bash(…) ✓" box.
    // Blank legacy filler is dropped in there too (see the module).
    const restored = restoreMessages(session.sessionId, history)
    state.setMessages(restored)
    // The agent only sees what is handed to it: without this the model
    // kept answering from the PREVIOUS conversation while the screen showed
    // the resumed one, and its system prompt kept the memory block it was
    // built with at launch.
    state.onSessionResumed?.(restored)
    // Wholesale replace → remount <Static> so the restored history
    // prints from item 0 (Ink's static index can't rewind).
    state.setStaticEpoch((e) => e + 1)
    // Transcript-only: persisting this banner would replay it as
    // history on the next resume, stacking a duplicate per resume.
    // The counts say what came back: the conversation rows handed to the
    // agent, and the long-term memories now in its context.
    const memories = state.memoryCount?.() ?? 0
    const detail = ` (${restored.length} earlier message${restored.length === 1 ? "" : "s"}, ${memories} long-term memor${memories === 1 ? "y" : "ies"})`
    state.addSystemMessage(
      `Resumed session: ${session.sessionName}${session.sessionDescription ? ` - ${session.sessionDescription}` : ""}${detail}`,
      { persist: false },
    )
  },
  onArchive: (session: SessionEntry): void => {
    archiveSession(session.sessionId)
    state.addSystemMessage(`Archived session: ${session.sessionName}`, { persist: false })
  },
  onRename: (session: SessionEntry, name: string): void => {
    renameSession(session.sessionId, name)
    state.addSystemMessage(`Renamed session → "${name}"`, { persist: false })
  },
  onDelete: (session: SessionEntry): void => {
    deleteSession(session.sessionId)
    state.addSystemMessage(`Deleted session: ${session.sessionName}`, { persist: false })
  },
  onFork: (session: SessionEntry): void => {
    const child = createSession(`${session.sessionName} (fork)`, session.sessionDescription)
    const history = loadConversation(session.sessionId)
    for (const h of history) {
      appendConversation(child.sessionId, h.role, h.content, {
        toolCallId: h.toolCallId,
        toolName: h.toolName,
        toolStatus: h.toolStatus,
        thinking: h.thinking,
      })
    }
    state.addSystemMessage(
      `Forked "${session.sessionName}" → "${child.sessionName}" (${history.length} messages) — select it to resume.`,
      { persist: false },
    )
  },
  onExit: (): void => {
    state.setShowPicker(/*showPicker*/ false)
  },
  onNewChat: (): void => {
    state.setShowPicker(/*showPicker*/ false)
    state.sessionIdRef.current = null
    state.currentSessionRef.current = null
    state.setMessages([])
    state.setStaticEpoch((e) => e + 1)
    state.addSystemMessage("New conversation started.", { persist: false })
  },
})
