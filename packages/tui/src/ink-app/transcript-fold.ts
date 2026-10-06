/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { TrayambakMessage } from "./types.js"

/**
 * In-memory transcript bound — the fix for heap-death freezes (observed:
 * 4GB Mark-Compact spiral, Ink REPL exit 134, after long tool-heavy
 * sessions). The UI transcript keeps EVERY row by design, and every streamed
 * token copies the whole messages array (`slice(0, -1).concat`) — so once
 * accumulated tool outputs + stale thinking reach GBs, each token triggers
 * a full-heap copy and the GC never catches up ("stuck", then OOM).
 *
 * foldTranscript() keeps all rows but folds the CONTENT of old,
 * no-longer-needed payloads once the transcript passes the soft cap:
 * oldest tool outputs collapse to head+tail, stale assistant thinking is
 * dropped (the newest reasoning stays). Model context is unaffected (the
 * agent session + 85% compaction own that); resume-from-disk is unaffected
 * (the session file keeps full outputs); `/expand` still shows the LAST
 * tool result in full (only older ones fold).
 *
 * Returns the SAME array reference when under the cap, so a wrapping
 * `setMessages(prev => foldTranscript(prev))` effect bails out with no
 * re-render and terminates after one fold pass.
 */

/** Fold once the retained transcript passes this many content bytes. */
export const TRANSCRIPT_SOFT_CAP_BYTES = 1_500_000
/** Newest tool-result rows that always stay full (covers `/expand`). */
export const TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS = 8
/** Newest assistant rows whose thinking stays (older reasoning folds away). */
export const TRANSCRIPT_FOLD_KEEP_NEWEST_THINKING = 2
/** Bytes kept at each end of a folded tool output. */
export const TRANSCRIPT_FOLD_HEAD_TAIL_BYTES = 600

function rowBytes(m: TrayambakMessage): number {
  let n = m.content.length + (m.thinking?.length ?? 0) + (m.result?.length ?? 0)
  n += m.subagentDetail?.length ?? 0
  if (m.parts) {
    for (const p of m.parts) {
      const text = p.text
      if (text && typeof text === "object" && "text" in text && typeof text.text === "string") {
        n += text.text.length
      }
    }
  }
  return n
}

function foldToolContent(content: string): string {
  const head = content.slice(0, TRANSCRIPT_FOLD_HEAD_TAIL_BYTES)
  const tail = content.slice(-TRANSCRIPT_FOLD_HEAD_TAIL_BYTES)
  const keptKb = ((head.length + tail.length) / 1024).toFixed(1)
  const totalKb = (content.length / 1024).toFixed(0)
  return `${head}\n…[output folded: showing ${keptKb}KB of ${totalKb}KB]\n${tail}`
}

export function foldTranscript(messages: TrayambakMessage[]): TrayambakMessage[] {
  let total = 0
  for (const m of messages) total += rowBytes(m)
  if (total <= TRANSCRIPT_SOFT_CAP_BYTES) return messages

  // Newest-first indexes of foldable rows. Tool-call REQUEST rows
  // (assistant + toolCallId) carry the full result in `result` — every tool
  // output lives twice in heap (here + the tool role row), so both fold.
  const toolIdx: number[] = []
  const thinkIdx: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if ((m.role === "tool" || (m.role === "assistant" && m.toolCallId)) && !m.transientHidden) toolIdx.push(i)
    if (m.role === "assistant" && !m.toolCallId && (m.thinking?.length ?? 0) > 0) thinkIdx.push(i)
  }
  const foldTools = new Set(toolIdx.slice(TRANSCRIPT_FOLD_KEEP_NEWEST_TOOLS))
  const foldThinking = new Set(thinkIdx.slice(TRANSCRIPT_FOLD_KEEP_NEWEST_THINKING))
  if (foldTools.size === 0 && foldThinking.size === 0) return messages

  let changed = false
  const out = messages.map((m, i) => {
    if (foldTools.has(i)) {
      let next = m
      if (m.content.length > TRANSCRIPT_FOLD_HEAD_TAIL_BYTES * 2 + 64) {
        // Skip rows that already folded (idempotent — the marker is proof).
        if (!m.content.includes("[output folded: showing")) {
          next = { ...next, content: foldToolContent(m.content) }
        }
      }
      const result = next.result ?? ""
      if (result.length > TRANSCRIPT_FOLD_HEAD_TAIL_BYTES * 2 + 64 && !result.includes("[output folded: showing")) {
        next = { ...next, result: foldToolContent(result) }
      }
      if (next !== m) changed = true
      return next
    }
    if (foldThinking.has(i) && (m.thinking?.length ?? 0) > 0) {
      changed = true
      const { thinking: _dropped, ...rest } = m
      return { ...rest, thinking: "" }
    }
    return m
  })
  return changed ? out : messages
}
