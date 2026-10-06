/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ConversationEntry } from "../../../../skt/9-session/session.js"
import type { TrayambakMessage } from "./types.js"

/**
 * Rebuild the live message list from a persisted conversation.
 *
 * Live state holds ONE message per tool call — an assistant-role row with
 * `toolCallId` + `toolName` + args JSON content + `result` + status (that is
 * what MessageRow renders as the bordered "Called bash(…) ✓" box). The log,
 * however, stores that call as a PAIR (agent-loop persists args at emit,
 * updateConversationToolResult patches the outcome onto the separate tool
 * row):
 *
 *   { role: "assistant", content: '{"command":"ls -la"}' }   ← args, no id
 *   { role: "tool", toolName: "bash", content: same args, … result }
 *
 * Restoring the pair literally used to render BOTH halves raw: a junk
 * `{"command":…}` text row (the box fields live on the other row) plus a
 * `✓ bash — {…}` one-liner whose `result` the tool-row renderer ignores —
 * "LINES" garbage on every resume ("SUNO LINES FIX KARO" report). This
 * re-merges the pair into the same single message live state builds, so a
 * resumed transcript is visually identical to the live one.
 *
 * Pairing is CERTAIN-ONLY: exact args-content equality (both rows are
 * written from the same event payload) or an already-shared toolCallId,
 * bounded by the turn's user message. An unpaired tool row still falls back
 * to the one-liner, an unpaired args row still shows its content — never a
 * wrong merge (a wrong merge would attach one call's result to another).
 */

/** Pre-fix sessions stamped this filler after every tool batch; paired with
 *  empty content it renders nothing and must not replay as a row. */
const LEGACY_JUNK = "The model returned no content. Please try again."

const isArgsShaped = (content: string): boolean => {
  const t = content.trim()
  if (!t.startsWith("{")) return false
  try {
    const parsed: unknown = JSON.parse(t)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
  } catch {
    return false
  }
}

export function restoreMessages(sessionId: string, history: ConversationEntry[]): TrayambakMessage[] {
  const rendersNothing = (h: ConversationEntry): boolean =>
    h.role === "assistant" &&
    !h.toolCallId &&
    !(h.thinking ?? "").trim() &&
    (h.content.trim() === "" || h.content === LEGACY_JUNK)

  const entries = history.filter((h) => !rendersNothing(h))

  // Pair each tool row with ITS args row: first unmatched preceding
  // assistant row (within this turn) whose content is byte-identical to the
  // tool row's args, or that already carries the same toolCallId.
  const argsTool = new Map<number, ConversationEntry>() // args-row index → tool entry
  const skipRows = new Set<number>() // tool rows consumed (merged or duplicate)
  const firstToolById = new Map<string, number>() // call id → first tool-row index
  const mergeOutcome = (into: ConversationEntry, from: ConversationEntry): void => {
    if (from.result !== undefined) into.result = from.result
    if (from.isError !== undefined) into.isError = from.isError
    if (from.toolStatus !== undefined && from.toolStatus !== "running") {
      into.toolStatus = from.toolStatus
    }
    if (from.durationMs !== undefined) into.durationMs = from.durationMs
  }
  entries.forEach((h, i) => {
    if (h.role !== "tool" || !h.toolName) return
    // Duplicate tool rows for one call (legacy start+result rows): fold the
    // later outcome into the first row and drop the duplicate.
    if (h.toolCallId) {
      const firstIdx = firstToolById.get(h.toolCallId)
      if (firstIdx !== undefined) {
        mergeOutcome(entries[firstIdx], h)
        skipRows.add(i)
        return
      }
      firstToolById.set(h.toolCallId, i)
    }
    // Turn boundary: never borrow an args row from an earlier turn.
    let start = 0
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j].role === "user") {
        start = j + 1
        break
      }
    }
    let match = -1
    for (let j = start; j < i; j++) {
      if (argsTool.has(j)) continue // already claimed by an earlier tool row
      const p = entries[j]
      if (p.role !== "assistant") continue
      const sameId = !!h.toolCallId && !!p.toolCallId && p.toolCallId === h.toolCallId
      const sameArgs = isArgsShaped(p.content) && p.content === h.content
      if (sameId || sameArgs) {
        match = j
        break
      }
    }
    if (match === -1) return // standalone tool row → one-liner fallback
    argsTool.set(match, h)
    skipRows.add(i)
  })

  const out: TrayambakMessage[] = []
  entries.forEach((h, i) => {
    if (skipRows.has(i)) return
    const tool = argsTool.get(i)
    const status = (s: ConversationEntry["toolStatus"]): TrayambakMessage["toolStatus"] =>
      s === "running" ? "completed" : s // never restore a stale running row
    const row: TrayambakMessage = {
      id: `restored-${sessionId}-${i}`,
      timestamp: new Date(h.ts).getTime(),
      role: h.role,
      // Collapsed pastes restore collapsed: the log keeps full text in
      // `content` (model context) and the shown block in `display`.
      content: h.display ?? h.content,
      toolName: h.toolName,
      toolCallId: h.toolCallId,
      toolStatus: status(h.toolStatus),
      thinking: h.thinking,
      result: h.result,
      isError: h.isError,
      durationMs: h.durationMs,
    }
    if (tool) {
      // The pair → the single live-shaped message: args row's position and
      // thinking, tool row's identity + outcome.
      row.toolName = row.toolName ?? tool.toolName
      row.toolCallId = row.toolCallId ?? tool.toolCallId
      row.toolStatus = status(tool.toolStatus)
      row.result = tool.result
      row.isError = tool.isError
      row.durationMs = tool.durationMs
    }
    out.push(row)
  })
  return out
}

export default restoreMessages
