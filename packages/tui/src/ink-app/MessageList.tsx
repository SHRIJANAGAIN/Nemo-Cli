/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Box, Static, Text, useStdout } from "ink"
import { MessageRow } from "./MessageRow.js"
import { ThinkingOrbs } from "./ThinkingOrbs.js"
import type { TrayambakMessage, AppStatus } from "./types.js"
import { useThemeColors } from "./themeColors.js"
import { stringWidth, graphemes } from "./utils/stringWidth.js"

export interface MessageListProps {
  messages: TrayambakMessage[]
  isLoading?: boolean
  isStreaming?: boolean
  extraBottomRows?: number
  /** App's turn phase: "running" = text is streaming — the bottom status
   *  line then says "Generating…" (cycling colors = the generation
   *  animation) instead of "Thinking…", and the tail row stops re-showing
   *  its reasoning spinner (reasoning is over; the answer is what moves). */
  phase?: AppStatus
  /** Bumped by App whenever `messages` is replaced wholesale (session
   *  restore, /clear, new chat): a new key remounts <Static> so Ink resets
   *  its print index and accumulated static output — the new history must
   *  print from item 0, not from the previous session's index. */
  staticEpoch?: number
  /** Reports whether a scrollback prefix exists (Static items > 0). App
   *  then drops the ROOT frame's top border (borderTop={false}): its
   *  ┌────┐ line would sit between the evicted prefix and the live tail,
   *  slicing the conversation in half mid-transcript ("ye line … must
   *  hide"). The prefix's │ walls flow straight into the frame's instead
   *  → ONE continuous conversation box. Fresh sessions (no prefix) keep
   *  the ┌ cap. */
  onHasPrefix?: (hasPrefix: boolean) => void
  /** Reports how many messages sit ABOVE the live frame (window start
   *  index = capIdx), so App's footer can show the `↑ N` depth chip ("how
   *  big is the chat upside"). Pure info — the frame itself never moves
   *  (auto-scroll only). Value-stable → React bails out on the identical
   *  state, no setState loop. */
  onScrollDepth?: (depth: number) => void
  /** Ctrl+O: tool outputs render full (200-line cap) instead of head+tail
   *  preview; tool-role rows and compaction markers unfold. */
  expandOutput?: boolean
  /** Turn start epoch ms (App sets it on turn_start): the bottom status
   *  line shows elapsed seconds (`Thinking… 12s`) so a slow model never
   *  reads as dead. Absent → no seconds. */
  turnStartedAt?: number
}

/** Wrapped row count for text with hard newlines: every line contributes
 *  its own ceil(len/width). The old char-count math (ceil(bodyLen/cols))
 *  treated a 45-line directory listing as ONE run-on string — est ~17 rows
 *  vs ~50 real — so the budget window over-filled and the overflow clip ate
 *  the NEWEST rows (the response's tail hidden right above the input box).
 *  Over-counting only evicts older rows to scrollback (still reachable by
 *  the terminal's native scroll — they print BORDERED, as the conversation
 *  box's continuation), so the bias stays HIGH. */
function wrappedRows(text: string, width: number): number {
  if (!text) return 0
  const lines = text.split("\n")
  // A trailing newline doesn't render an extra blank line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  let rows = 0
  for (const line of lines) rows += Math.max(1, Math.ceil(stringWidth(line) / width))
  return Math.max(1, rows)
}

/** The transcript body used for row math and head/tail slicing: final
 *  `content` when present, else the text parts (thinking/toolCall parts
 *  carry no transcript text). */
export function messageText(m: TrayambakMessage): string {
  if (m.content) return m.content
  if (m.parts && m.parts.length > 0) {
    const texts: string[] = []
    for (const p of m.parts) if (p.text) texts.push(p.text.text)
    if (texts.length > 0) return texts.join("\n")
  }
  return ""
}

/** Only messages that render their body as plain text can be head/tail
 *  sliced (tool cards, collapsed tool rows and subagent cards draw their
 *  own boxes — slicing their content would corrupt the card). */
export function rendersAsText(m: TrayambakMessage): boolean {
  return !m.subagentId && m.role !== "tool" && !(m.role === "assistant" && !!m.toolName && !!m.toolCallId)
}

/** Split `text` into a head and a BOTTOM-anchored tail that fits
 *  `availRows` (line-granular; char-granular for one giant line). The two
 *  parts are disjoint and concatenate back to the exact original body, so
 *  a head printed to scrollback + a tail shown in-frame reads as one
 *  continuous message — nothing hidden, nothing duplicated. */
export function splitAtRows(text: string, availRows: number, cols: number): { head: string; tail: string } {
  if (!text || availRows < 1) return { head: "", tail: text }
  const lines = text.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  let used = 0
  let cut = lines.length
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const r = Math.max(1, Math.ceil(stringWidth(lines[i] ?? "") / cols))
    if (used + r > availRows) break
    used += r
    cut = i
  }
  if (cut === lines.length) {
    // Even the last line alone overflows availRows (one giant line):
    // slice that line by GRAPHEME CLUSTERS from the end — binary-search the
    // smallest cluster cut whose tail still fits (fit grows as the cut
    // grows). A UTF-16 index can land between a base and its matra, which
    // would strand a combining mark at the head/tail seam.
    const last = lines.pop() ?? ""
    const starts: number[] = [0]
    for (const g of graphemes(last)) starts.push((starts[starts.length - 1] ?? 0) + g.length)
    const fitsIdx = (i: number): boolean => wrappedRows(last.slice(starts[i] ?? 0), cols) <= availRows
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (fitsIdx(mid)) hi = mid
      else lo = mid + 1
    }
    let idx = fitsIdx(lo) ? lo : -1
    if (idx < 0) {
      // Even the smallest tail overflows: fall back to the char-estimate
      // cut, snapped down to the nearest grapheme boundary.
      const approx = Math.max(0, last.length - Math.max(1, availRows) * cols)
      idx = 0
      for (let i = starts.length - 1; i >= 0; i -= 1) {
        if ((starts[i] ?? 0) <= approx) {
          idx = i
          break
        }
      }
    }
    const k = starts[idx] ?? 0
    const head = [...lines, last.slice(0, k)].join("\n")
    return { head, tail: last.slice(k) }
  }
  return { head: lines.slice(0, cut).join("\n"), tail: lines.slice(cut).join("\n") }
}

/** Estimated rendered rows for one message (wrap + its marginTop row).
 *  Biased HIGH: over-estimating only hides older messages (they still
 *  live in scrollback), while under-estimating let the overflow clip eat
 *  the NEWEST rows. `expandOutput` (Ctrl+O) must be passed through: an
 *  unfolded 200-line tool result budgets like one, or the frame overflows
 *  and the clip eats the live answer below it. */
export function estimateMessageRows(m: TrayambakMessage, cols: number, expandOutput = false): number {
  // TTL-expired notice (transientHidden): the frame renders it as NOTHING →
  // it must cost NO budget, or the split would evict real conversation to
  // make room for an invisible row. Flag-only — the row itself never leaves
  // the array (index-stable for the print-once frontier).
  if (m.transientHidden) return 0
  if (m.subagentId) {
    const detailLen = Math.min((m.subagentDetail ?? "").trim().length, 2000)
    const avail = Math.max(20, cols - 4)
    return 6 + Math.ceil(detailLen / avail)
  }
  if (m.role === "tool") return 2 // collapsed one-liner
  if (m.role === "assistant" && m.toolName && m.toolCallId) {
    let rows = 4
    const res = (m.result ?? "").replace(/\r/g, "")
    if (res) {
      const all = res.split("\n")
      const avail = Math.max(20, cols - 6) // borders + result prefix
      if (expandOutput) {
        // Ctrl+O unfolds the ToolCallItem result to its full 200 lines:
        // budget every shown line wrapped, exactly like the renderer (cap
        // + 4-col bullet prefix + overflow marker), plus slack. avail stays
        // at/below the renderer's wrap width and the cap at/below its cut,
        // so the count is biased HIGH — the documented safe direction. The
        // old code kept the collapsed ~10-row estimate here, so an unfolded
        // wall of output overflowed the frame budget and the overflow clip
        // ate everything below it, including the live answer
        // ("assistant ka half message hide").
        const cap = Math.max(40, (cols - 12) * 3)
        rows += 1 // result block marginTop
        for (const line of all.slice(0, 200)) {
          const cut = Math.min(line.length + 4, cap) + (line.length + 4 > cap ? 1 : 0)
          rows += Math.max(1, Math.ceil(cut / avail))
        }
        if (all.length > 200) rows += 1 // overflow marker line
        rows += 2 // slack for the cols≈termWidth approximation
      } else {
        const cap = Math.max(40, avail * 3)
        rows += 1 // result block marginTop
        for (const line of all.slice(0, 5)) {
          const len = Math.min(line.length, cap) + (line.length > cap ? 1 : 0) + 4
          rows += Math.max(1, Math.ceil(len / avail))
        }
        if (all.length > 5) rows += 1 // overflow line
      }
    }
    return rows + 1
  }
  if (m.parts && m.parts.length > 0) {
    let textRows = 0
    let structure = 0
    for (const p of m.parts) {
      if (p.text) textRows = Math.max(textRows, wrappedRows(p.text.text, cols))
      if (p.thinking) {
        textRows = Math.max(textRows, wrappedRows(p.thinking.text, cols))
        structure += 2 // spinner row + margin
      }
      if (p.toolCall) structure += 4 // compact bordered call
    }
    // The plain content/thinking render paths mirror the parts path, so
    // budget whichever side is taller.
    textRows = Math.max(textRows, wrappedRows(m.content ?? "", cols), wrappedRows(m.thinking ?? "", cols))
    // User bubble padding (paddingY=1): +2 rows, same for parts-bearing rows.
    return Math.max(1, textRows) + structure + 1 + (m.role === "user" ? 2 : 0) // margin + 1 slack
  }
  // Margin (+1) + newline-aware wrap of the content and thinking bodies.
  // User bubble padding (paddingY=1): +2 rows.
  return wrappedRows(m.content ?? "", cols) + wrappedRows(m.thinking ?? "", cols) + 1 + (m.role === "user" ? 2 : 0)
}

/** Rows Ink must keep re-rendering: live tool rows, running subagent
 *  cards, and the message still streaming right now. Everything else is
 *  FINAL and may print to scrollback exactly once. */
export function isUnstableMessage(
  m: TrayambakMessage,
  idx: number,
  total: number,
  isLoading: boolean,
  isStreaming: boolean,
): boolean {
  return (
    m.toolStatus === "running" ||
    m.toolStatus === "pending" ||
    m.subagentState === "running" ||
    ((isStreaming || isLoading) && idx === total - 1)
  )
}

export interface MessageSplit {
  /** Newest-first budget window into the DYNAMIC (in-frame) tail. */
  capIdx: number
  /** First index Ink must keep re-rendering (unstable frontier). */
  firstUnstable: number
}

/** Pure split math (unit-tested): tail cap over the dynamic part plus the
 *  unstable frontier. */
export function computeMessageSplit(
  messages: TrayambakMessage[],
  isLoading: boolean,
  isStreaming: boolean,
  rowBudget: number,
  cols: number,
  expandOutput = false,
): MessageSplit {
  let firstUnstable = messages.length
  for (let i = 0; i < messages.length; i += 1) {
    if (isUnstableMessage(messages[i], i, messages.length, isLoading, isStreaming)) {
      firstUnstable = i
      break
    }
  }
  // Tail cap: keep the newest messages that fit — the frame clips
  // (overflow="hidden") instead of shrinking rows, so over-running it
  // would cut the NEWEST rows off the bottom.
  let used = 0
  let capIdx = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const rows = estimateMessageRows(messages[i], cols, expandOutput)
    if (used + rows > rowBudget && capIdx !== messages.length) break
    used += rows
    capIdx = i
  }
  return { capIdx, firstUnstable }
}

/** Coverage invariant for tests: every message is either printed to
 *  scrollback (below the frontier) or rendered in-frame (at/after capIdx).
 *  Rows strictly between frontier and capIdx are transiently unrendered
 *  mid-run only — at rest firstUnstable === messages.length so the split
 *  is exact and NOTHING is hidden, at ANY budget (i.e. any height). */
export function splitCoversAll(frontier: number, capIdx: number): boolean {
  return frontier <= capIdx
}

/** UI transcript memory bound (OOM guard): run.session gets compacted by
 *  token policy, but the visible transcript used to keep EVERY row for the
 *  whole TUI lifetime — a heavy day (tool storms, reasoning traces) grew
 *  the heap without bound (observed live: 4GB death). Past MAX, App drops
 *  the oldest rows from React state and remounts Static via staticEpoch;
 *  the dropped rows stay in terminal scrollback (already printed) and in
 *  the session file, so nothing becomes unreachable. Sizing: worst-case
 *  rows run ~256KB (bash cap) → 1000 rows ≈ 256MB worst case, typical rows
 *  ~1–4KB → single-digit MB. Hysteresis (prune to KEEP, not to MAX) keeps
 *  the rare remount from firing per message. */
export const UI_MAX_MESSAGES = 1000
export const UI_KEEP_MESSAGES = 750

/** Head-drop the transcript when it exceeds the memory bound. Returns the
 *  same array reference when nothing must go (no churn, no re-render). */
export function pruneMessages<T>(messages: readonly T[]): { messages: readonly T[]; pruned: number } {
  if (messages.length <= UI_MAX_MESSAGES) return { messages, pruned: 0 }
  return { messages: messages.slice(-UI_KEEP_MESSAGES), pruned: messages.length - UI_KEEP_MESSAGES }
}

/** An oversized COMPLETED answer split across the scroll boundary: the head
 *  is printed to <Static> (scrollback) while the tail stays in-frame. Cut
 *  once, permanently for the epoch — Ink's static index only moves forward,
 *  so the head must never be re-cut (a resize would otherwise re-print or
 *  overlap rows). */
export interface HeadSplit {
  headText: string
  tailText: string
}

const stripForSlice = (m: TrayambakMessage, id: string, content: string): TrayambakMessage => ({
  ...m,
  id,
  content,
  parts: undefined,
  thinking: undefined,
  toolCallId: undefined,
  toolName: undefined,
  toolStatus: undefined,
  result: undefined,
  subagentId: undefined,
})

/** Static items for <Static>: the printed prefix, expanded with the split
 *  message's head (and, once it leaves the dynamic window, its tail — it
 *  would otherwise fall out of the frame unprinted). Append-only: item N
 *  of this list is always the same object it was on the previous render, so
 *  Ink's forward-only print index never rewinds or rewrites scrollback.
 *  The eager head for the NEWEST split answer prints the moment it
 *  finishes (only when the prefix reaches its index exactly — otherwise a
 *  mid-run unstable gap would shift later rows and silently skip them).
 *  Every item renders as a side-bordered slice of the conversation box
 *  (│ on both edges), so scrollback rows are never naked lines. */
export function buildStaticItems(
  messages: TrayambakMessage[],
  frontier: number,
  capIdx: number,
  splits: ReadonlyMap<string, HeadSplit>,
): TrayambakMessage[] {
  const out: TrayambakMessage[] = []
  for (let i = 0; i < frontier; i += 1) {
    const m = messages[i]
    const sp = splits.get(m.id)
    if (!sp) {
      out.push(m)
      continue
    }
    out.push(stripForSlice(m, `${m.id}::head`, sp.headText))
    if (i < capIdx) out.push(stripForSlice(m, `${m.id}::tail`, sp.tailText))
  }
  const last = messages.length - 1
  if (last >= 0 && frontier === last) {
    const sp = splits.get(messages[last]!.id)
    if (sp) out.push(stripForSlice(messages[last]!, `${messages[last]!.id}::head`, sp.headText))
  }
  return out
}

export const MessageList = ({
  messages,
  isLoading = false,
  isStreaming = false,
  extraBottomRows = 0,
  phase,
  staticEpoch = 0,
  onHasPrefix,
  onScrollDepth,
  expandOutput = false,
  turnStartedAt,
}: MessageListProps): ReactNode => {
  const { stdout } = useStdout()
  const theme = useThemeColors()

  // In-frame height budget: root border(2) + footer(~3) + composer(~2) ≈ 7
  // chrome rows (the compact logo header is gone — it burned 2 rows per
  // transcript; the old +1 was the "N older messages hidden" hint — gone)
  // + 1 row of Windows-ink slack (root Box is height={rows-1} in App.tsx —
  // outputHeight must stay BELOW the viewport or ink's win32 path wipes
  // screen+scrollback and reprints the whole prefix on EVERY render:
  // the per-token generation storm, "scrollbar stuck at 2 places / drag
  // snaps back"). Budget tracks the box: messages area = rows-8 there.
  // The frame holds the NEWEST messages that fit rowBudget; the stable
  // prefix that falls out of the window prints ONCE to <Static> above the
  // frame — always BORDERED (│ on both edges: the conversation box's
  // continuation, ┌ cap on the very first row), so the terminal's native
  // scroll always shows old history INSIDE a box, never naked lines
  // floating over it. The frame
  // itself is full window height minus that slack (height={rows-1} in
  // App.tsx), so its rows
  // stretch DOWN to fill the box as the conversation grows. Every row
  // wrapper is flexShrink={0} (rows never compress → gaps survive at ANY
  // width) and this Box clips (overflow="hidden"), so the transcript can
  // never paint over the footer/composer rows.
  const cols = Math.max(20, (stdout.columns || 80) - 6)
  // The frame window shows the NEWEST messages that fit the row budget —
  // no marker line steals a row from history ("history ke liye wo hide
  // nahi chahiye, pura show hota rahe"). Older rows fall out the top into
  // the print-once <Static> prefix where the terminal's NATIVE scroll
  // reads them (no in-app window: the up-down wheel-park is removed by
  // decision — "only auto scroll": the frame always holds the newest
  // messages, generation included, so no scroll can hide the response).
  const rowBudget = Math.max(6, (stdout.rows || 40) - 8 - extraBottomRows)

  // <Static>'s forward-only print index and the head/tail split table are
  // PER-EPOCH: a wholesale replace (/clear, new chat, session restore)
  // bumps staticEpoch → the new history prints from item 0 instead of
  // continuing the previous session's scrollback ("old must be same": rows
  // already printed are never re-cut or rewritten).
  const epochRef = useRef(0)
  const frontierRef = useRef(0)
  const splitsRef = useRef(new Map<string, HeadSplit>())
  if (epochRef.current !== staticEpoch) {
    epochRef.current = staticEpoch
    frontierRef.current = 0
    splitsRef.current = new Map()
  }

  const { capIdx, firstUnstable } = computeMessageSplit(messages, isLoading, isStreaming, rowBudget, cols, expandOutput)

  // Oversized COMPLETED answer: cut head/tail ONCE, permanently for this
  // epoch (Ink's static index only moves forward — a later re-cut would
  // desync what already printed). The head then prints to scrollback
  // bordered the moment the frontier reaches it; the frame keeps the tail
  // so the response's END stays visible above the input box. ANY completed
  // text row qualifies — assistant/system AND user: a 30-line pasted blob
  // lost its whole head forever because only the tail rendered (the frame
  // clips top-first, static had no frozen head to print). Tool rows,
  // subagent cards and assistant tool-call cards never qualify (they draw
  // their own boxes — rendersAsText is false for them, and slicing their
  // content would corrupt the card).
  if (capIdx === messages.length - 1 && messages.length > 0) {
    const m = messages[messages.length - 1]!
    if (
      rendersAsText(m) &&
      !isUnstableMessage(m, messages.length - 1, messages.length, isLoading, isStreaming) &&
      !splitsRef.current.has(m.id) &&
      estimateMessageRows(m, cols) > rowBudget
    ) {
      const { head, tail } = splitAtRows(messageText(m), Math.max(1, rowBudget - 1), cols)
      if (head) splitsRef.current.set(m.id, { headText: head, tailText: tail })
    }
  }

  // Printed prefix: everything strictly below the frontier has settled and
  // prints exactly once (bordered) — between the old frontier and the new
  // one, never re-printing what Ink already wrote.
  const frontier = Math.max(frontierRef.current, Math.min(firstUnstable, capIdx))
  frontierRef.current = frontier
  // Memoized so the ARRAY IDENTITY survives idle re-renders (the 500ms clock,
  // the cursor blink). Ink's <Static> compares `items` and, on a fresh array
  // it treats the output as "new static content" → log.clear() → a full-frame
  // reprint at the cursor every single tick, which stacks a frame clone per
  // repaint. A stable reference lets Ink's forward-only print index sit still
  // so only the live tail repaints. Splits are cached in splitsRef, so this
  // recomputes exactly when the printed prefix really changed.
  const staticItems = useMemo(
    () => buildStaticItems(messages, frontier, capIdx, splitsRef.current),
    [messages, frontier, capIdx],
  )

  // Frame window: ALWAYS the newest messages that fit the row budget, ending
  // at the live tail (auto-scroll only — no offset state exists anywhere, so
  // no scroll can hide the response). Rows older than the window fell out
  // the top into the print-once prefix (see buildStaticItems above),
  // reachable by the terminal's NATIVE scroll; the frame re-showing a prefix
  // row would be a bottom-of-screen duplicate of scrollback content.
  const dynamicMessages = messages.slice(capIdx)

  // Elapsed-seconds ticker for the bottom status line: ticks ONLY while
  // the tail is loading (mid-turn repaints already flow then). At
  // idle there is deliberately no timer — zero writes, so the Windows
  // scrollbar and native drag hold position (idle-silence contract).
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!isLoading) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [isLoading])
  const elapsedSuffix =
    isLoading && turnStartedAt !== undefined ? ` ${Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000))}s` : ""

  // Tell App when the scrollback prefix exists so the root frame can drop
  // its TOP border — otherwise its ┌────┐ line renders between the prefix
  // and the live tail and cuts the transcript in two ("ye line … must
  // hide"). Fires only when the count actually changes (append-only), so
  // no setState loop.
  useEffect(() => {
    onHasPrefix?.(staticItems.length > 0)
  }, [staticItems.length, onHasPrefix])

  // Depth chip: tell App how many messages the frame window starts below
  // (all of them already live in the print-once prefix / scrollback).
  // Fires only when capIdx changes (append-only growth shrinks it), and
  // setting the same value bails out in React — no loop.
  useEffect(() => {
    onScrollDepth?.(capIdx)
  }, [capIdx, onScrollDepth])

  // Bottom-anchored slice for a message too tall for the frame: render its
  // LAST rows in-frame with NO hint/marker row so the response's END is
  // always visible above the input box (the old top-anchored render let the
  // overflow clip eat the tail — "half response hidden below the input").
  // A FROZEN split is returned as-is (its head already printed to
  // scrollback — re-cutting would duplicate rows); an unstable one
  // recomputes every render so the cut re-anchors live while streaming.
  const dynamicSlice = (msg: TrayambakMessage): string | null => {
    if (!rendersAsText(msg)) return null
    const frozen = splitsRef.current.get(msg.id)
    if (frozen) return frozen.tailText
    if (estimateMessageRows(msg, cols, expandOutput) <= rowBudget) return null
    const avail = Math.max(1, rowBudget - 1) // the row's marginTop
    const { tail } = splitAtRows(messageText(msg), avail, cols)
    return tail
  }

  const tail = dynamicMessages[dynamicMessages.length - 1]
  /** Bottom "Thinking…" line shows ONLY when the tail row isn't already
   *  showing one (see below). `generating` = text streaming right now (vs
   *  the pre-token reasoning phase). Computed here so JSX stays declarative. */
  const generating = phase === "running"
  const tailShowsThinking =
    isStreaming &&
    !generating && // tokens are flowing: reasoning is over, not "Thinking…"
    !!tail &&
    tail.role === "assistant" &&
    (tail.thinking ?? "").length > 0

  return (
    <>
      {/* Print-once prefix: rows that fell out of the frame's budget
          window, rendered with the conversation box's side borders
          (│ … │) so scrollback reads as the SAME box continuing upward —
          never naked lines above it. The first printed item carries the
          ╭ cap (round corners + primary-blue outline, matching the App
          root frame exactly so the two boxes' walls merge seamlessly).
          The key remounts <Static> on epoch change → Ink resets its print
          index for the new history. */}
      <Static
        key={`messages-static-${staticEpoch}`}
        items={staticItems}
        style={{ width: Math.max(20, stdout.columns || 80) }}
      >
        {(m, idx) => (
          <Box
            key={m.id}
            flexShrink={0}
            flexDirection="column"
            width="100%"
            borderStyle="round"
            borderColor={theme.primary}
            borderTop={idx === 0}
            borderBottom={false}
          >
            {/* No marginLeft here: the border's │ occupies exactly the
                frame's border column, so MessageRow lines up with its
                in-frame twin (same columns, same wrap width). */}
            <MessageRow message={m} isStreaming={false} expandOutput={expandOutput} />
          </Box>
        )}
      </Static>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {messages.length === 0 && !isLoading && (
            <Box flexDirection="column" alignItems="center" marginTop={2} flexShrink={0}>
              <Text dimColor>No messages yet. Type a message to begin.</Text>
            </Box>
          )}
          {/* No ↑ history marker row: it cost a budget row of HISTORY for a
            hint the window itself already proves ("no need see ye … pura
            show hota rahe"). Scrolled or live — the frame is all history. */}
          {dynamicMessages.map((msg, dynIdx) => {
            // TTL-expired notice: drop it from the LIVE frame only. The row
            // stays in `messages` (the split/frontier index into it) and a
            // copy already printed to <Static> keeps its scrollback content —
            // hiding must never re-cut what Ink wrote.
            if (msg.transientHidden) return null
            // column + stretch: the row box defaults to a flex ROW, which sizes
            // its child (MessageRow) to CONTENT — the tool box then hugged its
            // 45-col header instead of filling the terminal ("jitni window
            // width utna stretched"). As a column child, MessageRow cross-axis
            // STRETCHES to this box's width, so every width="100%" resolves
            // against the full frame content width.
            const slice = dynamicSlice(msg)
            if (slice) {
              // Oversized answer: its BOTTOM rows only, no hint row. The frame
              // shows the response's END (bottom-anchored) instead of letting
              // the overflow clip eat it under the input box; its head printed
              // BORDERED to scrollback above (wheel-up reads the whole answer
              // as one continuous boxed message).
              return (
                <Box key={msg.id} flexShrink={0} flexDirection="column">
                  <MessageRow
                    message={{ ...msg, content: slice, parts: undefined, thinking: undefined }}
                    isStreaming={false}
                    expandOutput={expandOutput}
                  />
                </Box>
              )
            }
            return (
              <Box key={msg.id} flexShrink={0} flexDirection="column">
                {/* Thinking spinner ONLY on the tail row: MessageRow shows
                "Thinking…" for any assistant carrying thinking text while
                isStreaming — without this gate every OLD completed answer
                re-grew a spinner below itself whenever a later turn
                streamed (the paste's "answer done, ⠙ Thinking… stuck
                under it"). */}
                <MessageRow
                  message={msg}
                  isStreaming={isStreaming && dynIdx === dynamicMessages.length - 1}
                  phase={phase}
                  expandOutput={expandOutput}
                />
              </Box>
            )
          })}
          {/* Bottom spinner ONLY when the tail row isn't already showing one:
          with isLoading && isStreaming both true mid-turn, the tail
          assistant row renders "Thinking…" AND this line rendered a second
          one ("2 THINKING APPEARS WHEN AI GENERATE RESPONSES"). The bottom
          line covers the pre-first-token phase and non-assistant tails.
          Phase-aware: while TEXT streams (phase "running") it reads
          "Generating…" and cycleColors ANIMATES it (Footer's waiting-chip
          treatment) — the old code spun "Thinking…" through the whole
          answer. */}
          {/* Bottom shimmer ONLY when the tail row isn't already showing one:
          the pre-first-token phase (and a non-assistant tail) has no row to
          carry the word, so it lives here instead — exactly one per frame,
          never two. */}
          {isLoading && !tailShowsThinking && (
            <Box marginTop={1} marginLeft={1} flexShrink={0}>
              <ThinkingOrbs
                label={generating ? "Generating…" : "Thinking…"}
                suffix={elapsedSuffix}
              />
            </Box>
          )}
        </Box>
        {/* No custom gutter here by decision: the Windows inbuilt scrollbar
            owns the frame edge — a second in-app bar in the same gray read
            as a smear/dupe next to it. Wheel/page/anchor/pill/footer-chip
            are untouched; only the drawn bar is gone. */}
      </Box>
    </>
  )
}

export default MessageList
