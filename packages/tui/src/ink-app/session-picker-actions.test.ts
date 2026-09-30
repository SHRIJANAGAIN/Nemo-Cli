/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Behavioral tests for the SessionPicker handlers extracted from App.tsx
 * (session-picker-actions.ts). The session store and the restore module are
 * mocked; these pin the resume / fork / archive / new-chat STATE SEMANTICS
 * the inline JSX handlers used to own — same-session no-op resume,
 * default-name title backfill, transcript-only banners (persist: false),
 * history replay on fork (AGENTS.md: behavioral code gets tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_SESSION_NAME, type SessionEntry } from "../../../../skt/9-session/session.js"
import { createSessionPickerActions, type SessionPickerState } from "./session-picker-actions.js"

const io = vi.hoisted(() => ({
  loadConversation: vi.fn(),
  archiveSession: vi.fn(),
  renameSession: vi.fn(),
  deleteSession: vi.fn(),
  createSession: vi.fn(),
  appendConversation: vi.fn(),
  titleFromConversation: vi.fn(),
}))

const restore = vi.hoisted(() => ({ restoreMessages: vi.fn() }))

vi.mock("../../../../skt/9-session/session.js", () => ({
  ...io,
  DEFAULT_SESSION_NAME: "New Session",
}))

vi.mock("./restore-messages.js", () => restore)

/** Minimal valid SessionEntry; override per test. */
const entry = (over: Partial<SessionEntry> & { sessionId: string }): SessionEntry => ({
  sessionName: "Demo",
  sessionDescription: "desc",
  startedAt: "2026-09-29T00:00:00.000Z",
  messageCount: 3,
  totalTokens: 42,
  status: "active",
  ...over,
})

/** A persisted tool-call row as loadConversation returns it (fork replays it). */
const historyRow = {
  role: "assistant",
  content: "Called bash",
  toolCallId: "call_1",
  toolName: "bash",
  toolStatus: "done",
  thinking: "planning",
}

// `satisfies` keeps the Mock types (tests read `.mock`), while still
// checking the object fulfils SessionPickerState.
const makeState = () =>
  ({
    setShowPicker: vi.fn(),
    sessionIdRef: { current: null as string | null },
    currentSessionRef: { current: null as SessionEntry | null },
    setMessages: vi.fn(),
    setStaticEpoch: vi.fn(),
    addSystemMessage: vi.fn(() => ""),
  }) satisfies SessionPickerState

const actions = (state = makeState()) => ({
  state,
  handlers: createSessionPickerActions(state),
})

beforeEach(() => {
  vi.clearAllMocks()
  io.loadConversation.mockReturnValue([])
  io.titleFromConversation.mockReturnValue("")
  restore.restoreMessages.mockReturnValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("onSelect (resume)", () => {
  it("is a no-op when the clicked session is already on screen", () => {
    const { state, handlers } = actions()
    state.sessionIdRef.current = "s1"

    handlers.onSelect(entry({ sessionId: "s1" }))

    // Picker still closes (it must not strand the user), but nothing reloads:
    // reloading live state from a lagging log.jsonl drops the in-flight turn.
    expect(state.setShowPicker).toHaveBeenCalledWith(false)
    expect(io.loadConversation).not.toHaveBeenCalled()
    expect(state.setMessages).not.toHaveBeenCalled()
    expect(state.addSystemMessage).not.toHaveBeenCalled()
  })

  it("restores history, remounts the static transcript, and banners resume", () => {
    const { state, handlers } = actions()
    state.sessionIdRef.current = "old"
    state.currentSessionRef.current = entry({ sessionId: "old" })
    io.loadConversation.mockReturnValue([historyRow])
    restore.restoreMessages.mockReturnValue(["msg-a", "msg-b"])

    handlers.onSelect(entry({ sessionId: "s2" }))

    expect(state.sessionIdRef.current).toBe("s2")
    expect(state.currentSessionRef.current?.sessionId).toBe("s2")
    expect(io.loadConversation).toHaveBeenCalledWith("s2")
    expect(restore.restoreMessages).toHaveBeenCalledWith("s2", [historyRow])
    expect(state.setMessages).toHaveBeenCalledWith(["msg-a", "msg-b"])
    // Wholesale replace → the static epoch bumps so Ink reprints from item 0.
    expect(state.setStaticEpoch).toHaveBeenCalledTimes(1)
    const bump = state.setStaticEpoch.mock.calls[0][0] as (n: number) => number
    expect(bump(41)).toBe(42)
    // Transcript-only: persisted banners would replay and stack per resume.
    expect(state.addSystemMessage).toHaveBeenCalledWith("Resumed session: Demo - desc", { persist: false })
  })

  it("drops the ' - description' tail when the session has none", () => {
    const { state, handlers } = actions()

    handlers.onSelect(entry({ sessionId: "s2", sessionDescription: "" }))

    expect(state.addSystemMessage).toHaveBeenCalledWith("Resumed session: Demo", { persist: false })
  })

  it("backfills a default-named session's title from its own history", () => {
    const { state, handlers } = actions()
    io.titleFromConversation.mockReturnValue("Backfilled Title")

    handlers.onSelect(entry({ sessionId: "s2", sessionName: DEFAULT_SESSION_NAME }))

    // Deterministic rename (no provider round-trip) + the banner uses it.
    expect(io.renameSession).toHaveBeenCalledWith("s2", "Backfilled Title")
    expect(state.currentSessionRef.current?.sessionName).toBe("Backfilled Title")
    expect(state.addSystemMessage).toHaveBeenCalledWith("Resumed session: Backfilled Title - desc", {
      persist: false,
    })
  })

  it("never renames a user-chosen title (and skips backfill when no title derives)", () => {
    const { handlers } = actions()

    handlers.onSelect(entry({ sessionId: "s2", sessionName: "My Custom Name" }))
    expect(io.renameSession).not.toHaveBeenCalled()

    vi.clearAllMocks()
    io.titleFromConversation.mockReturnValue("")
    handlers.onSelect(entry({ sessionId: "s3", sessionName: DEFAULT_SESSION_NAME }))
    expect(io.renameSession).not.toHaveBeenCalled()
  })
})

describe("archive / rename / delete / fork / exit / new-chat", () => {
  it("archives with a transcript-only confirmation", () => {
    const { state, handlers } = actions()

    handlers.onArchive(entry({ sessionId: "s1" }))

    expect(io.archiveSession).toHaveBeenCalledWith("s1")
    expect(state.addSystemMessage).toHaveBeenCalledWith("Archived session: Demo", { persist: false })
  })

  it("renames through the store and confirms the new name", () => {
    const { state, handlers } = actions()

    handlers.onRename(entry({ sessionId: "s1" }), "Fresh Name")

    expect(io.renameSession).toHaveBeenCalledWith("s1", "Fresh Name")
    expect(state.addSystemMessage).toHaveBeenCalledWith('Renamed session → "Fresh Name"', { persist: false })
  })

  it("deletes through the store and confirms", () => {
    const { state, handlers } = actions()

    handlers.onDelete(entry({ sessionId: "s1" }))

    expect(io.deleteSession).toHaveBeenCalledWith("s1")
    expect(state.addSystemMessage).toHaveBeenCalledWith("Deleted session: Demo", { persist: false })
  })

  it("forks: replays every persisted row into the new session id", () => {
    const { state, handlers } = actions()
    io.createSession.mockReturnValue(entry({ sessionId: "child-9", sessionName: "Demo (fork)" }))
    io.loadConversation.mockReturnValue([historyRow, { ...historyRow, toolCallId: "call_2", content: "done" }])

    handlers.onFork(entry({ sessionId: "s1" }))

    expect(io.createSession).toHaveBeenCalledWith("Demo (fork)", "desc")
    expect(io.loadConversation).toHaveBeenCalledWith("s1")
    expect(io.appendConversation).toHaveBeenCalledTimes(2)
    expect(io.appendConversation).toHaveBeenCalledWith("child-9", "assistant", "Called bash", {
      toolCallId: "call_1",
      toolName: "bash",
      toolStatus: "done",
      thinking: "planning",
    })
    expect(io.appendConversation).toHaveBeenCalledWith("child-9", "assistant", "done", {
      toolCallId: "call_2",
      toolName: "bash",
      toolStatus: "done",
      thinking: "planning",
    })
    expect(state.addSystemMessage).toHaveBeenCalledWith(
      'Forked "Demo" → "Demo (fork)" (2 messages) — select it to resume.',
      { persist: false },
    )
  })

  it("onExit only closes the picker", () => {
    const { state, handlers } = actions()

    handlers.onExit()

    expect(state.setShowPicker).toHaveBeenCalledWith(false)
    expect(state.setMessages).not.toHaveBeenCalled()
    expect(state.sessionIdRef.current).toBeNull()
  })

  it("new chat resets the live session, empties the transcript, and bumps the epoch", () => {
    const { state, handlers } = actions()
    state.sessionIdRef.current = "s1"
    state.currentSessionRef.current = entry({ sessionId: "s1" })

    handlers.onNewChat()

    expect(state.setShowPicker).toHaveBeenCalledWith(false)
    expect(state.sessionIdRef.current).toBeNull()
    expect(state.currentSessionRef.current).toBeNull()
    expect(state.setMessages).toHaveBeenCalledWith([])
    const bump = state.setStaticEpoch.mock.calls[0][0] as (n: number) => number
    expect(bump(0)).toBe(1)
    expect(state.addSystemMessage).toHaveBeenCalledWith("New conversation started.", { persist: false })
  })
})
