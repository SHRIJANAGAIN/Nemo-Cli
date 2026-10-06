/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  CLOSED_PICKER,
  applyMention,
  clampSelection,
  closePicker,
  detectMention,
  moveSelection,
  openPicker,
  quotePath,
  rankCandidates,
  type MentionToken,
} from "./file-picker.js"

const NOW = 1_800_000_000_000
const DAY = 86_400_000

/** Shorthand: the token `@q` typed at the end of `prefix`. */
function tokenOf(draft: string): MentionToken {
  const found = detectMention(draft, draft.length)
  if (!found) throw new Error(`no mention in ${JSON.stringify(draft)}`)
  return found
}

describe("detectMention", () => {
  it("finds a bare mention at the start of the draft", () => {
    expect(tokenOf("@src/a")).toEqual({ start: 0, end: 6, query: "src/a" })
  })

  it("finds a mention after a space", () => {
    expect(tokenOf("look at @src/a")).toEqual({ start: 8, end: 14, query: "src/a" })
  })

  it("returns an empty query immediately after the @", () => {
    expect(tokenOf("look at @")).toEqual({ start: 8, end: 9, query: "" })
  })

  it("treats a bare @ as an empty mention — that is how the picker opens", () => {
    expect(detectMention("@", 1)).toEqual({ start: 0, end: 1, query: "" })
    expect(detectMention("hello @", 7)).toEqual({ start: 6, end: 7, query: "" })
  })

  it("does not treat a space-separated @ as a mention", () => {
    // "@ foo" is the word "at", not a file query.
    expect(detectMention("@ foo", 5)).toBeNull()
    expect(detectMention("a @ b", 5)).toBeNull()
  })

  it("does not treat an email address as a mention", () => {
    expect(detectMention("dev@corp.ts", 11)).toBeNull()
    expect(detectMention("a@b", 3)).toBeNull()
  })

  it("stops the query at a shell operator", () => {
    // Otherwise `@a.ts&&rm -rf` would offer a "path" containing the command.
    expect(detectMention("@a.ts", 5)).toEqual({ start: 0, end: 5, query: "a.ts" })
    expect(detectMention("@a.ts;rm", 8)).toBeNull()
    expect(detectMention("@a.ts|cat", 9)).toBeNull()
    expect(detectMention("@a.ts$USER", 10)).toBeNull()
  })

  it("is caret-relative — text after the caret is not part of the query", () => {
    expect(detectMention("@src/a and then more", 6)).toEqual({ start: 0, end: 6, query: "src/a" })
  })

  it("narrows the query as the caret moves left inside the token", () => {
    // Editing mid-token must keep tracking the mention, not dismiss it — that is
    // the whole point of resolving the token from the caret rather than from the
    // end of the string.
    expect(detectMention("@src/a", 6)?.query).toBe("src/a")
    expect(detectMention("@src/a", 3)?.query).toBe("sr")
    expect(detectMention("@src/a", 1)?.query).toBe("")
    expect(detectMention("@src/a", 0)).toBeNull()
  })

  it("survives a caret past the end of the string", () => {
    expect(detectMention("@ab", 99)).toEqual({ start: 0, end: 3, query: "ab" })
  })

  it("returns null rather than throwing on an empty draft", () => {
    expect(detectMention("", 0)).toBeNull()
    expect(detectMention("", -5)).toBeNull()
  })

  it("handles a path with a slash after a word without a space", () => {
    expect(detectMention("see@src", 8)).toBeNull()
  })
})

describe("quotePath", () => {
  it("leaves a plain path alone", () => {
    expect(quotePath("src/app.ts")).toBe("src/app.ts")
  })

  it("quotes a path containing a space", () => {
    expect(quotePath("my file.ts")).toBe('"my file.ts"')
  })

  it("quotes and escapes a path containing a quote", () => {
    expect(quotePath('a"b.ts')).toBe('"a\\"b.ts"')
  })

  it("quotes shell metacharacters that would otherwise be operators", () => {
    expect(quotePath("a&b.ts")).toBe('"a&b.ts"')
    expect(quotePath("$HOME/x.ts")).toBe('"$HOME/x.ts"')
  })
})

describe("applyMention", () => {
  it("replaces the token and leaves no trailing space at end of draft", () => {
    const draft = "look at @src/a"
    const out = applyMention(draft, tokenOf(draft), "src/app.ts")
    expect(out.draft).toBe("look at src/app.ts")
    expect(out.caret).toBe(out.draft.length)
  })

  it("adds a separating space when text follows the caret", () => {
    // Without it, `look at src/app.tsand then` would be one token.
    const draft = "@src/a and then"
    const out = applyMention(draft, detectMention(draft, 6)!, "src/app.ts")
    expect(out.draft).toBe("src/app.ts and then")
    expect(out.draft).toContain("src/app.ts ")
  })

  it("does not double a space that is already there", () => {
    const draft = "@src/a rest"
    const out = applyMention(draft, detectMention(draft, 6)!, "src/app.ts")
    expect(out.draft).toBe("src/app.ts rest")
  })

  it("quotes the inserted path so a spaced filename survives", () => {
    const draft = "@my"
    const out = applyMention(draft, tokenOf(draft), "my file.ts")
    expect(out.draft).toBe('"my file.ts"')
  })

  it("replaces every occurrence of the typed token, not the first", () => {
    const draft = "@a"
    const out = applyMention(draft, tokenOf(draft), "x/y.ts")
    expect(out.draft).toBe("x/y.ts")
    expect(out.draft).not.toContain("@a")
  })

  it("leaves text before the token intact", () => {
    // Caret at the end: the SECOND mention completes, the earlier one stays typed.
    const draft = "first @second @th"
    const out = applyMention(draft, detectMention(draft, draft.length)!, "z.ts")
    expect(out.draft).toBe("first @second z.ts")
  })

  it("replaces only the mention the caret is inside, not an earlier one", () => {
    // Caret 10 is inside "@second", so "@sec" is replaced and the rest of that
    // same token ("ond") plus the LATER mention survive untouched.
    const draft = "first @second @th"
    const out = applyMention(draft, detectMention(draft, 10)!, "z.ts")
    expect(out.draft).toBe("first z.ts ond @th")
  })

  it("round-trips a mention with a spaced path back out of the draft", () => {
    const draft = "check @my"
    const out = applyMention(draft, tokenOf(draft), "my file.ts")
    expect(out.draft).toBe('check "my file.ts"')
    expect(out.caret).toBe(out.draft.length)
  })
})

describe("rankCandidates", () => {
  const frecency = [
    { path: "src/hot.ts", opens: 12, lastOpened: NOW },
    { path: "src/old.ts", opens: 200, lastOpened: NOW - 400 * DAY },
  ]

  it("puts the working set above a heavily used but stale file", () => {
    expect(rankCandidates({ query: "src/", frecency, now: NOW })[0]?.path).toBe("src/hot.ts")
  })

  it("fills the tail with scanned files, never-opened ones last", () => {
    const rows = rankCandidates({ query: "", frecency, scanned: ["src/new.ts"], now: NOW })
    expect(rows.map((r) => r.path)).toEqual(["src/hot.ts", "src/old.ts", "src/new.ts"])
  })

  it("does not list a scanned file twice when it is already in the store", () => {
    const rows = rankCandidates({ query: "", frecency, scanned: ["src/hot.ts"], now: NOW })
    expect(rows.filter((r) => r.path === "src/hot.ts")).toHaveLength(1)
  })

  it("filters case-insensitively", () => {
    expect(rankCandidates({ query: "HOT", frecency, scanned: [], now: NOW }).map((r) => r.path)).toEqual(["src/hot.ts"])
  })

  it("ranks the scanned tail by query specificity, so more typing narrows it", () => {
    const scanned = ["a/very/long/path/to/somewhere/else.ts", "a/b.ts"]
    const rows = rankCandidates({ query: "a/", scanned, now: NOW })
    expect(rows[0]?.path).toBe("a/b.ts")
  })

  it("marks a never-opened file with zero opens rather than pretending it was used", () => {
    const rows = rankCandidates({ query: "", frecency: [], scanned: ["x.ts"], now: NOW })
    expect(rows[0]).toEqual({ path: "x.ts", opens: 0, lastOpened: 0 })
  })

  it("honours a limit and survives an empty candidate set", () => {
    expect(rankCandidates({ query: "", frecency, limit: 1 })).toHaveLength(1)
    expect(rankCandidates({ query: "", frecency: [], scanned: [] })).toEqual([])
  })

  it("is stable for equal scores — the list must not reshuffle between keystrokes", () => {
    const scanned = ["a.ts", "b.ts", "c.ts"]
    const first = rankCandidates({ query: "", scanned }).map((r) => r.path)
    const second = rankCandidates({ query: "", scanned: [...scanned].reverse() }).map((r) => r.path)
    expect(second).toEqual(first)
  })
})

describe("picker cursor", () => {
  it("opens on the best row", () => {
    expect(openPicker("src")).toEqual({ query: "src", index: 0, open: true })
  })

  it("closes and forgets the previous selection", () => {
    const moved = moveSelection(openPicker("s"), 1, 5)
    expect(moved.index).toBe(1)
    // A stale index restored on re-open would select a row the user never saw.
    expect(closePicker(moved)).toEqual({ query: "s", index: 0, open: false })
  })

  it("moves down and wraps at the end", () => {
    expect(moveSelection(openPicker(""), 1, 3).index).toBe(1)
    expect(moveSelection(openPicker(""), 3, 3).index).toBe(0)
  })

  it("moves up and wraps at the start", () => {
    expect(moveSelection({ query: "", index: 0, open: true }, -1, 3).index).toBe(2)
  })

  it("survives a delta far larger than the list", () => {
    // Modulo without normalisation would land on a negative index.
    expect(moveSelection(openPicker(""), 1000, 3).index).toBe(1)
    expect(moveSelection(openPicker(""), -1000, 3).index).toBe(2)
  })

  it("ignores movement when the picker is closed or the list is empty", () => {
    expect(moveSelection(CLOSED_PICKER, 1, 5)).toEqual(CLOSED_PICKER)
    expect(moveSelection(openPicker(""), 1, 0).index).toBe(0)
  })

  it("clamps a selection left dangling by a narrowing query", () => {
    // Typing shrinks the list; index 4 must not survive to select row 0 unseen.
    const state = { query: "s", index: 4, open: true }
    expect(clampSelection(state, 2).index).toBe(1)
    expect(clampSelection(state, 0).index).toBe(0)
  })

  it("leaves a closed picker closed when clamped", () => {
    expect(clampSelection({ query: "s", index: 4, open: false }, 2)).toEqual({ query: "s", index: 0, open: false })
  })
})
