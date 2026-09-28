/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode, useEffect, useState } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { isEnter } from "./keys.js"
import { useAppInput } from "./useAppInput.js"
import type { SessionEntry } from "../../../../skt/9-session/session.js"

export interface SessionPickerProps {
  sessions: SessionEntry[]
  onSelect: (session: SessionEntry) => void
  onNewChat?: () => void
  onArchive?: (session: SessionEntry) => void
  /** Inline rename of the selected session (SKT AI LABS history-panel parity). */
  onRename?: (session: SessionEntry, name: string) => void
  /** Delete the selected session — always gated behind a y/n confirm. */
  onDelete?: (session: SessionEntry) => void
  /** Fork the selected session into a new one (copy of its transcript). */
  onFork?: (session: SessionEntry) => void
  onExit: () => void
}

type FilterMode = "all" | "active" | "completed" | "abandoned"
type SortMode = "updated" | "created" | "name" | "messages"

const STATUS_LABELS: Record<SessionEntry["status"], string> = {
  active: "ACTIVE",
  completed: "COMPLETED",
  abandoned: "ARCHIVED",
}

const STATUS_COLORS: Record<SessionEntry["status"], string> = {
  active: "green",
  completed: "cyan",
  abandoned: "gray",
}

export const SessionPicker = ({
  sessions,
  onSelect,
  onArchive,
  onRename,
  onDelete,
  onFork,
  onExit,
  onNewChat,
}: SessionPickerProps): ReactNode => {
  const theme = useThemeColors()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<FilterMode>("all")
  const [sort, setSort] = useState<SortMode>("updated")
  const [selected, setSelected] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  /** Inline rename editor — owns all input while true. */
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState("")
  // Blinky rename caret — same cell, solid ¦ ? space every 530ms, exactly
  // like the composer's (the hardware caret is hidden app-wide, so a
  // permanently-lit block reads as stuck).
  const [caretOn, setCaretOn] = useState(true)
  useEffect(() => {
    if (!editing) return
    const timer = setInterval(() => setCaretOn((v) => !v), 530)
    return () => clearInterval(timer)
  }, [editing])
  /** Armed delete confirmation — owns all input while true. */
  const [confirmDelete, setConfirmDelete] = useState(false)
  const MAX_VISIBLE = 20
  const hasNewChat = !!onNewChat
  /** Row 0 is "+ New Chat" when present, so filtered rows start at 1. */
  const offset = hasNewChat ? 1 : 0

  const filtered = sessions
    .filter((s) => {
      if (filter !== "all" && s.status !== filter) return false
      if (query) {
        const q = query.toLowerCase()
        return (
          s.sessionName.toLowerCase().includes(q) ||
          s.sessionDescription.toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q)
        )
      }
      return true
    })
    .sort((a, b) => {
      switch (sort) {
        case "created":
          return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        case "name":
          return a.sessionName.localeCompare(b.sessionName)
        case "messages":
          return b.messageCount - a.messageCount
        case "updated":
        default: {
          const aTime = new Date(a.endedAt ?? a.startedAt).getTime()
          const bTime = new Date(b.endedAt ?? b.startedAt).getTime()
          return bTime - aTime
        }
      }
    })

  const selectedEntry = filtered[selected - offset]
  const visible = filtered.slice(scrollTop, scrollTop + MAX_VISIBLE)

  // A delete (or a shrinking search) can leave `selected`/`scrollTop` past
  // the end of the list — clamp so Enter/arrows always address a real row
  // and at least one row stays visible (off-by-one fix).
  useEffect(() => {
    const maxIdx = Math.max(0, filtered.length - 1 + offset)
    const maxTop = Math.max(0, filtered.length - 1)
    if (selected > maxIdx) setSelected(maxIdx)
    if (scrollTop > maxTop) setScrollTop(maxTop)
  }, [filtered.length])

  // Restart selection at the top of a freshly filtered list — keeping the
  // old index would make Enter resume a DIFFERENT session mid-search
  // (search hijack fix).
  const resetSelection = (): void => {
    setSelected(offset)
    setScrollTop(0)
  }

  useAppInput((input, key) => {
    // Rename mode owns every key until Enter (save) or Esc (cancel).
    if (editing) {
      if (isEnter(input, key)) {
        const name = editName.trim()
        if (name && selectedEntry && onRename) onRename(selectedEntry, name)
        setEditing(false)
        return
      }
      if (key.escape) {
        setEditing(false)
        return
      }
      if (key.backspace) {
        setEditName((prev) => prev.slice(0, -1))
        return
      }
      if (input && input.length === 1 && input >= " " && input <= "~") {
        setEditName((prev) => prev + input)
        return
      }
      return
    }

    // Delete confirm owns every key until y/n/Esc.
    if (confirmDelete) {
      if (input === "y" || input === "Y" || isEnter(input, key)) {
        if (selectedEntry && onDelete) onDelete(selectedEntry)
        setConfirmDelete(false)
        return
      }
      if (input === "n" || input === "N" || key.escape) {
        setConfirmDelete(false)
        return
      }
      return
    }

    if (key.escape) {
      onExit()
      return
    }
    if (isEnter(input, key)) {
      // "+ New Chat" row: `filtered[-1]` was never a row — selecting it by
      // index 0 must work without a filtered hit (off-by-one fix).
      if (hasNewChat && selected === 0) {
        onNewChat?.()
        return
      }
      if (selectedEntry) onSelect(selectedEntry)
      return
    }
    if (input === "a" && key.ctrl && onArchive && selectedEntry) {
      onArchive(selectedEntry)
      return
    }
    if (key.upArrow) {
      const next = Math.max(0, selected - 1)
      setSelected(next)
      if (next < scrollTop) setScrollTop(next)
      return
    }
    if (key.downArrow) {
      // Must allow reaching the LAST session: with the New Chat row, valid
      // indices run 0..filtered.length (not ..length-1).
      const next = Math.min(filtered.length - 1 + offset, selected + 1)
      setSelected(next)
      if (next >= scrollTop + MAX_VISIBLE) setScrollTop(next - MAX_VISIBLE + 1)
      return
    }

    // Single-letter commands only while the search box is empty — otherwise
    // every letter belongs to the query ("profile" must not hit the filter
    // key; search hijack fix).
    if (!query) {
      if (input === "f") {
        const modes: FilterMode[] = ["all", "active", "completed", "abandoned"]
        const idx = modes.indexOf(filter)
        setFilter(modes[(idx + 1) % modes.length])
        resetSelection()
        return
      }
      if (input === "s") {
        const modes: SortMode[] = ["updated", "created", "name", "messages"]
        const idx = modes.indexOf(sort)
        setSort(modes[(idx + 1) % modes.length])
        resetSelection()
        return
      }
      if (input === "n" && hasNewChat) {
        onNewChat?.()
        return
      }
      if (input === "r" && selectedEntry && onRename) {
        setEditing(true)
        setEditName(selectedEntry.sessionName)
        return
      }
      if (input === "d" && selectedEntry && onDelete) {
        setConfirmDelete(true)
        return
      }
      if (input === "F" && selectedEntry && onFork) {
        onFork(selectedEntry)
        return
      }
    }

    // Unicode gate (mirrors PromptInput): the old ASCII-only range dropped
    // accented/emoji/CJK query chars. C0 controls are stripped, so Enter
    // ("\\r") and friends still fall through to their handlers below.
    if (input) {
      const clean = input.replace(/[\u0000-\u001f\u007f]/g, "")
      if (clean.length > 0) {
        setQuery((prev) => prev + clean)
        resetSelection()
        return
      }
    }
    if (key.backspace) {
      // Grapheme-safe (see PromptInput): never leave half an emoji.
      setQuery((prev) => Array.from(prev).slice(0, -1).join(""))
      resetSelection()
      return
    }
  })

  const formatDate = (iso: string): string => {
    const d = new Date(iso)
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const mins = Math.floor(diff / 60000)
    const hrs = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)
    if (mins < 1) return "just now"
    if (mins < 60) return `${mins}m ago`
    if (hrs < 24) return `${hrs}h ago`
    if (days < 7) return `${days}d ago`
    return d.toLocaleDateString()
  }

  return (
    <Box flexDirection="column" height="100%" paddingX={1}>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color={theme.primary}>
          Resume Session
        </Text>
        <Text dimColor>
          {filtered.length} sessions · Filter: {filter} · Sort: {sort}
        </Text>
      </Box>

      {editing ? (
        <Box marginBottom={1}>
          <Text color={theme.warning}>
            ? Rename: {editName}
            {caretOn ? "¦" : " "} (Enter save · Esc cancel)
          </Text>
        </Box>
      ) : confirmDelete && selectedEntry ? (
        <Box marginBottom={1}>
          <Text color={theme.error}>? Delete "{selectedEntry.sessionName}"? y confirm · n/esc cancel</Text>
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text color={theme.primary}>? </Text>
          <Text>{query || "Type to search..."}</Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1}>
        {hasNewChat && (
          <Box key="new-chat">
            <Text color={selected === 0 ? theme.primary : undefined} bold={selected === 0}>
              {selected === 0 ? "? " : "  "}
            </Text>
            <Text color="green">+ New Chat</Text>
          </Box>
        )}
        {filtered.length === 0 ? (
          <Text dimColor> No sessions found.</Text>
        ) : (
          visible.map((session, idx) => {
            const realIdx = offset + scrollTop + idx
            const isActive = realIdx === selected
            return (
              <Box key={session.sessionId}>
                <Text color={isActive ? theme.primary : undefined} bold={isActive}>
                  {isActive ? "? " : "  "}
                </Text>
                <Text color={STATUS_COLORS[session.status]}>{STATUS_LABELS[session.status]}</Text>
                <Text> </Text>
                <Text bold={isActive}>{session.sessionName}</Text>
                <Text dimColor>
                  {"  "}
                  {formatDate(session.endedAt ?? session.startedAt)}
                  {"  "}
                  {session.messageCount > 0
                    ? `${session.messageCount} msgs`
                    : session.sessionDescription || "New session"}
                </Text>
              </Box>
            )
          })
        )}
      </Box>

      <Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
        <Text dimColor>
          {" enter"} select {" esc"} exit {" r"} rename {" d"} delete {" F"} fork {" ctrl+a"} archive
        </Text>
        <Text dimColor>
          {" f"} filter {" s"} sort {" ?/?"} browse · f/s/r/d/F apply only while search is empty
        </Text>
      </Box>
    </Box>
  )
}

export default SessionPicker
