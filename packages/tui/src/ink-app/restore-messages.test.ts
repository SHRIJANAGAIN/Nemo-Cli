/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { restoreMessages } from "./restore-messages.js"
import type { ConversationEntry } from "../../../../skt/9-session/session.js"

/**
 * Resume-restore regression ("SUNO LINES FIX KARO"): the log stores each
 * tool call as an args-only assistant row + a separate tool row carrying
 * toolCallId/result. Restoring the raw pair rendered junk (`{"command":…}`
 * text + a `✓ tool — {…}` one-liner, result invisible) instead of the live
 * bordered "Called bash(…) ✓" box. These tests pin the re-merge into the
 * single live-shaped message (and the certain-only pairing rules).
 */

const TS = "2026-09-25T10:00:00.000Z"
const args = (command: string): string => JSON.stringify({ command })

const user = (content: string): ConversationEntry => ({ role: "user", content, ts: TS })
const prose = (content: string): ConversationEntry => ({ role: "assistant", content, ts: TS })
const argsRow = (content: string): ConversationEntry => ({ role: "assistant", content, ts: TS })
const toolRow = (content: string, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  role: "tool",
  content,
  ts: TS,
  toolCallId: "call-1",
  toolName: "bash",
  toolStatus: "completed",
  ...extra,
})

describe("restoreMessages — pair re-merge", () => {
  it("merges args+tool rows into ONE live-shaped message (box fields)", () => {
    const out = restoreMessages("s", [
      user("list files"),
      prose("let me look"),
      argsRow(args("ls -la")),
      toolRow(args("ls -la"), { result: "total 8", isError: false }),
    ])
    expect(out).toHaveLength(3) // tool row consumed, no duplicate one-liner
    const box = out[2]
    expect(box.role).toBe("assistant")
    expect(box.content).toBe(args("ls -la")) // args render inside the box
    expect(box.toolName).toBe("bash")
    expect(box.toolCallId).toBe("call-1")
    expect(box.toolStatus).toBe("completed")
    expect(box.result).toBe("total 8")
    expect(box.isError).toBe(false)
    // no raw-JSON junk row and no `✓ bash — {…}` one-liner left
    expect(out.some((m) => m.role === "tool")).toBe(false)
  })

  it("never restores a stale running row", () => {
    const out = restoreMessages("s", [
      user("x"),
      argsRow(args("whoami")),
      toolRow(args("whoami"), { toolStatus: "running" }),
    ])
    expect(out[1].toolStatus).toBe("completed")
    expect(out).toHaveLength(2)
  })

  it("keeps thinking that rode on the args row", () => {
    const out = restoreMessages("s", [
      user("x"),
      { ...argsRow(args("ls")), thinking: "hmm" },
      toolRow(args("ls"), { result: "ok" }),
    ])
    expect(out[1].thinking).toBe("hmm")
    expect(out[1].result).toBe("ok")
  })

  it("merges an error outcome (✗) from the tool row", () => {
    const out = restoreMessages("s", [
      user("x"),
      argsRow(args("bad")),
      toolRow(args("bad"), { toolStatus: "error", isError: true, result: "boom" }),
    ])
    expect(out[1].toolStatus).toBe("error")
    expect(out[1].isError).toBe(true)
    expect(out[1].result).toBe("boom")
  })
})

describe("restoreMessages — certain-only pairing", () => {
  it("FIFO-pairs parallel identical-shape batches by content (results not swapped)", () => {
    const a = args("one")
    const b = args("two")
    const out = restoreMessages("s", [
      user("run both"),
      argsRow(a),
      argsRow(b),
      toolRow(a, { toolCallId: "c1", result: "first" }),
      toolRow(b, { toolCallId: "c2", toolName: "read_file", result: "second" }),
    ])
    expect(out).toHaveLength(3)
    expect(out[1].content).toBe(a)
    expect(out[1].result).toBe("first")
    expect(out[1].toolCallId).toBe("c1")
    expect(out[2].content).toBe(b)
    expect(out[2].result).toBe("second")
    expect(out[2].toolName).toBe("read_file")
  })

  it("claims each args row at most once (repeated identical commands)", () => {
    const same = args("ls")
    const out = restoreMessages("s", [
      user("twice"),
      argsRow(same),
      toolRow(same, { toolCallId: "c1", result: "run1" }),
      argsRow(same),
      toolRow(same, { toolCallId: "c2", result: "run2" }),
    ])
    expect(out).toHaveLength(3)
    expect(out[1].result).toBe("run1")
    expect(out[2].result).toBe("run2")
    expect(out[1].toolCallId).toBe("c1")
    expect(out[2].toolCallId).toBe("c2")
  })

  it("pairs by shared toolCallId when the args row already carries it", () => {
    const out = restoreMessages("s", [
      user("x"),
      { ...argsRow(args("ls")), toolCallId: "c9" },
      toolRow(args("ls"), { toolCallId: "c9", toolName: "bash", result: "ok" }),
    ])
    expect(out).toHaveLength(2)
    expect(out[1].toolCallId).toBe("c9")
    expect(out[1].result).toBe("ok")
  })

  it("never borrows an args row from an earlier turn", () => {
    const same = args("ls")
    const out = restoreMessages("s", [
      user("first"),
      argsRow(same), // orphan: its tool row was never persisted
      user("second"),
      argsRow(same),
      toolRow(same, { result: "second-run" }),
    ])
    // turn-1 orphan stays a plain args row; turn-2 pair merges
    expect(out).toHaveLength(4)
    expect(out[1].toolName).toBeUndefined()
    expect(out[3].result).toBe("second-run")
  })

  it("keeps an unpaired tool row as the one-liner fallback", () => {
    const out = restoreMessages("s", [user("x"), toolRow(args("ls"), { toolCallId: "c1" })])
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe("tool")
    expect(out[1].toolName).toBe("bash")
  })

  it("keeps an unpaired args row as content (never dropped)", () => {
    const out = restoreMessages("s", [user("x"), argsRow(args("ls"))])
    expect(out).toHaveLength(2)
    expect(out[1].content).toBe(args("ls"))
  })

  it("folds duplicate tool rows for one call (legacy start+result)", () => {
    const out = restoreMessages("s", [
      user("x"),
      argsRow(args("ls")),
      toolRow(args("ls"), { toolStatus: "running" }), // start row
      toolRow(args("ls"), { toolStatus: "completed", result: "late" }), // result row
    ])
    expect(out).toHaveLength(2) // one box row, dup dropped
    expect(out[1].result).toBe("late")
    expect(out[1].toolStatus).toBe("completed")
  })
})

describe("restoreMessages — legacy junk filter", () => {
  it("drops empty assistant rows and the pre-fix filler line", () => {
    const out = restoreMessages("s", [
      user("x"),
      { role: "assistant", content: "", ts: TS, thinking: "  " },
      { role: "assistant", content: "The model returned no content. Please try again.", ts: TS },
      prose("real answer"),
    ])
    expect(out).toHaveLength(2)
    expect(out[1].content).toBe("real answer")
  })

  it("keeps a real answer even if it is JSON-shaped prose", () => {
    const out = restoreMessages("s", [user("x"), prose('{"hello":"world"}')])
    expect(out).toHaveLength(2) // no tool row to pair with → untouched
    expect(out[1].content).toBe('{"hello":"world"}')
  })
})
