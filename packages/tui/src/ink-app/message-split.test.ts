/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  type HeadSplit,
  buildStaticItems,
  computeMessageSplit,
  estimateMessageRows,
  isUnstableMessage,
  messageText,
  splitAtRows,
  splitCoversAll,
} from "./MessageList.js"
import type { TrayambakMessage } from "./types.js"

function msg(id: string, role: TrayambakMessage["role"] = "user", extra?: Partial<TrayambakMessage>): TrayambakMessage {
  return { id, timestamp: 1, role, content: `body of ${id}`, ...extra }
}

describe("computeMessageSplit", () => {
  it("keeps the newest budget-fitting window (older rows leave the top of the box)", () => {
    const messages = [msg("u1"), msg("a1", "assistant"), msg("u2"), msg("a2", "assistant")]
    for (const budget of [6, 12, 33, 100, 500]) {
      const { capIdx } = computeMessageSplit(messages, false, false, budget, 100)
      const window = messages.slice(capIdx)
      // The newest message ALWAYS renders inside the frame …
      expect(window[window.length - 1]).toBe(messages[messages.length - 1])
      // … the window is a contiguous suffix of the list (rows are never
      // skipped mid-window): rows the budget can't hold leave the TOP of
      // the window and print ONCE above the frame — BORDERED, as the
      // conversation box's continuation (never naked lines over it).
      expect(window).toEqual(messages.slice(capIdx))
      if (budget >= 12) expect(capIdx).toBe(0) // everything fits → whole history in-frame
    }
  })

  it("always keeps an oversized tail dynamic (never clips the newest rows)", () => {
    const big = msg("big", "assistant", { content: "x".repeat(5000) })
    const messages = [msg("u1"), big]
    const { capIdx } = computeMessageSplit(messages, false, false, 10, 100)
    expect(capIdx).toBe(1)
  })

  it("marks the streaming tail + running tools unstable", () => {
    const messages = [msg("u1"), msg("a1", "assistant"), msg("u2")]
    const live = computeMessageSplit(messages, true, true, 100, 100)
    expect(live.firstUnstable).toBe(2)
    const tool = msg("t1", "tool", { toolCallId: "c1", toolName: "bash", toolStatus: "running" })
    expect(isUnstableMessage(tool, 0, 1, false, false)).toBe(true)
    const done = computeMessageSplit([...messages, tool], false, false, 100, 100)
    expect(done.firstUnstable).toBe(3)
  })

  it("estimates tool boxes above their box height (no clip-eats-newest)", () => {
    const tool = msg("t1", "assistant", {
      toolCallId: "c1",
      toolName: "bash",
      result: "line\n".repeat(10),
    })
    expect(estimateMessageRows(tool, 100)).toBeGreaterThan(6)
  })

  it("counts hard newlines (a 40-line listing is ~40 rows, not ceil(chars/cols))", () => {
    const listing = Array.from({ length: 40 }, (_, i) => `dir-${i}`).join("\n")
    const m = msg("a1", "assistant", { content: listing })
    // ~6 chars/line x 40 lines ≈ 240 chars — the old char-count math said
    // ceil(240/100) = 3 rows while the body renders 40 (+margin).
    expect(estimateMessageRows(m, 100)).toBeGreaterThanOrEqual(41)
  })
})

describe("splitAtRows (bottom-anchored tail for oversized answers)", () => {
  it("is disjoint and concatenates back to the exact body", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line-${i} content`).join("\n")
    const { head, tail } = splitAtRows(body, 20, 100)
    expect(head.length).toBeGreaterThan(0)
    expect(tail.length).toBeGreaterThan(0)
    expect([head, tail].join("\n")).toBe(body)
    // The tail fits the row budget it was cut for (line-granular, so ≤ avail
    // rows + no line wraps at 100 cols here).
    expect(tail.split("\n").length).toBeLessThanOrEqual(20)
  })

  it("handles one giant line char-granularly", () => {
    const body = "x".repeat(5000)
    const { head, tail } = splitAtRows(body, 20, 100)
    expect(head.length).toBeGreaterThan(0)
    expect(tail.length).toBeGreaterThan(0)
    expect(head + tail).toBe(body)
    expect(Math.ceil(tail.length / 100)).toBeLessThanOrEqual(20)
  })

  it("leaves short bodies untouched", () => {
    const { head, tail } = splitAtRows("one short answer", 30, 100)
    expect(head).toBe("")
    expect(tail).toBe("one short answer")
  })
})

describe("messageText (body used for row math and slicing)", () => {
  it("joins text parts when content is empty, else returns content", () => {
    const withParts: TrayambakMessage = {
      id: "p1",
      timestamp: 1,
      role: "assistant",
      content: "",
      parts: [{ text: { type: "text", text: "part one\npart two" } }],
    }
    expect(messageText(withParts)).toBe("part one\npart two")
    const tool = msg("t9", "assistant", { toolCallId: "c1", toolName: "bash", content: "{}" })
    expect(messageText(tool)).toBe("{}")
  })
})

describe("in-frame window across height changes", () => {
  it("re-slices cleanly as the budget grows/shrinks (nothing above the box)", () => {
    const messages: TrayambakMessage[] = []
    for (let i = 0; i < 12; i += 1) {
      messages.push(msg(`u${i}`))
      messages.push(msg(`a${i}`, "assistant"))
    }
    // 24 messages × ~2 rows = ~48 rows total. Every cycle: the window is a
    // contiguous SUFFIX ending at the newest message — re-slicing on each
    // height change can neither skip a row inside the window nor reprint
    // scrollback (the <Static> prefix above is append-only and BORDERED:
    // no print-index rewind, no naked escape).
    for (const budget of [33, 63, 33, 63, 12, 63]) {
      const { capIdx } = computeMessageSplit(messages, false, false, budget, 100)
      const window = messages.slice(capIdx)
      expect(window.length).toBe(messages.length - capIdx)
      expect(window[window.length - 1]).toBe(messages[messages.length - 1])
      if (budget >= 48) expect(capIdx).toBe(0) // generous → whole history in-frame
      if (budget <= 12) expect(capIdx).toBeGreaterThan(0) // tight → top rows leave the window
    }
  })
})

describe("buildStaticItems (print-once prefix for <Static>)", () => {
  const bigBody = Array.from({ length: 60 }, (_, i) => `row-${i}`).join("\n")

  /** The component's split table for an oversized body (same cut
   *  dynamicSlice/eager-cut use: avail = rowBudget - 1). */
  const splitsFor = (m: TrayambakMessage, avail: number, cols = 100): ReadonlyMap<string, HeadSplit> => {
    const { head, tail } = splitAtRows(messageText(m), avail, cols)
    return new Map([[m.id, { headText: head, tailText: tail }]])
  }

  it("covers every message exactly once at rest (nothing hidden)", () => {
    const b = msg("big", "assistant", { content: bigBody })
    const messages = [msg("u1"), b, msg("u2", "assistant"), msg("a2", "assistant")]
    const { capIdx, firstUnstable } = computeMessageSplit(messages, false, false, 10, 100)
    const frontier = Math.min(firstUnstable, capIdx) // what the component computes at rest
    expect(splitCoversAll(frontier, capIdx)).toBe(true)

    const items = buildStaticItems(messages, frontier, capIdx, splitsFor(b, 9))
    const staticBases = items.map((m) => m.id.replace(/::(head|tail)$/, ""))
    const window = messages.slice(capIdx).map((m) => m.id)

    // Static prefix + in-frame window = the whole conversation — no message
    // lost between them.
    for (const m of messages) expect([...staticBases, ...window]).toContain(m.id)
    // The big answer can't fit the window → it sits fully in the prefix as
    // head + tail, and the two halves reassemble its body EXACTLY.
    expect(staticBases.filter((id) => id === "big")).toHaveLength(2)
    const head = items.find((m) => m.id === "big::head")
    const tail = items.find((m) => m.id === "big::tail")
    expect([head?.content, tail?.content].join("\n")).toBe(bigBody)
    // …while the window keeps the newest rows.
    expect(window[window.length - 1]).toBe(messages[messages.length - 1]!.id)
  })

  it("appends only: item N stays identical as the turn grows (old must be same)", () => {
    const b = msg("big", "assistant", { content: bigBody })
    const splits = splitsFor(b, 9)
    const passes: TrayambakMessage[][] = []
    for (const messages of [
      [msg("u1"), b],
      [msg("u1"), b, msg("u2", "assistant")],
      [msg("u1"), b, msg("u2", "assistant"), msg("a2", "assistant")],
    ]) {
      const { capIdx, firstUnstable } = computeMessageSplit(messages, false, false, 10, 100)
      passes.push(buildStaticItems(messages, Math.min(firstUnstable, capIdx), capIdx, splits))
    }
    const [p1, p2, p3] = passes
    // 1st: the eager head for the COMPLETED oversized answer …
    expect(p1?.map((m) => m.id)).toEqual(["u1", "big::head"])
    // 2nd: only its TAIL is appended, at the END (Ink's print index moves
    // forward only — nothing before it may shift or change) …
    expect(p2?.map((m) => m.id)).toEqual(["u1", "big::head", "big::tail"])
    // 3rd: the turn grew but the prefix already printed → ZERO new items.
    expect(p3?.map((m) => m.id)).toEqual(p2?.map((m) => m.id))
    expect(p3?.[1]).toEqual(p2?.[1]) // same head object/content, byte-identical
  })

  it("strips thinking/parts from sliced items (only the body text prints)", () => {
    const b = msg("big", "assistant", {
      content: bigBody,
      thinking: "internal reasoning",
      parts: [{ text: { type: "text", text: "stale part" } }],
    })
    const messages = [msg("u1"), b, msg("u2", "assistant")]
    const { capIdx, firstUnstable } = computeMessageSplit(messages, false, false, 10, 100)
    const items = buildStaticItems(messages, Math.min(firstUnstable, capIdx), capIdx, splitsFor(b, 9))
    expect(items.map((m) => m.id)).toEqual(["u1", "big::head", "big::tail"])
    for (const half of items.slice(1)) {
      expect(half.thinking).toBeUndefined()
      expect(half.parts).toBeUndefined()
      expect(half.toolName).toBeUndefined()
    }
  })

  it("passes unsplit tool/subagent cards through untouched (no corrupt slices)", () => {
    const tool = msg("t1", "assistant", {
      toolCallId: "c1",
      toolName: "bash",
      toolStatus: "completed",
      result: "ok",
    })
    const items = buildStaticItems([tool], 1, 1, new Map())
    expect(items).toEqual([tool]) // same object: no ::head id, no field stripping
  })
})

describe("splitCoversAll (coverage invariant)", () => {
  it("holds at rest and flags a transient mid-run gap", () => {
    expect(splitCoversAll(0, 5)).toBe(true)
    expect(splitCoversAll(2, 2)).toBe(true) // rest: frontier lands exactly on capIdx
    expect(splitCoversAll(3, 2)).toBe(false) // unstable gap mid-run only
  })
})

describe("TTL-hidden notices (transientHidden flag)", () => {
  it("cost NO frame budget — a huge hidden row never evicts real conversation", () => {
    const hidden = msg("notice", "system", { content: "x".repeat(5000), transientHidden: true })
    expect(estimateMessageRows(hidden, 100)).toBe(0)
    const messages = [msg("u1"), hidden, msg("a1", "assistant")]
    const { capIdx } = computeMessageSplit(messages, false, false, 10, 100)
    // Unflagged, the 5000-char row alone blows the budget and pushes u1 out
    // of the window; flagged it costs zero rows → everything still fits:
    expect(capIdx).toBe(0)
  })

  it("keeps the row in the print-once prefix (the flag never re-cuts scrollback)", () => {
    const hidden = msg("notice", "system", { content: "mode notice", transientHidden: true })
    const items = buildStaticItems([hidden, msg("u1")], 1, 1, new Map())
    expect(items).toHaveLength(1)
    // Same object Ink already printed — index-stable, byte-identical:
    expect(items[0]).toBe(hidden)
  })
})
