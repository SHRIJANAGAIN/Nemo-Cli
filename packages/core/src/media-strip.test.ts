/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import {
  RECENT_MESSAGES_KEPT,
  countInlineMedia,
  hasInlineMedia,
  stripHistoricalMedia,
  type MaybeWithMedia,
} from "./media-strip.js"

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"

/** Wire-shaped stand-ins: the rule only ever reads `images`. */
interface Row extends MaybeWithMedia {
  readonly role: string
  readonly content: unknown
}
const user = (content: string, images?: string[]): Row => ({ role: "user", content, images })
const assistant = (content: string): Row => ({ role: "assistant", content })

describe("hasInlineMedia", () => {
  it("detects a message carrying images", () => {
    expect(hasInlineMedia(user("look", [PNG]))).toBe(true)
  })

  it("treats an empty image list as no media", () => {
    expect(hasInlineMedia(user("look", []))).toBe(false)
    expect(hasInlineMedia(user("look"))).toBe(false)
  })

  it("ignores a tool result (images live on user rows here)", () => {
    expect(
      hasInlineMedia({
        role: "tool",
        toolCallId: "t",
        toolName: "x",
        content: [{ type: "text", text: "o" }],
        isError: false,
      } as Row),
    ).toBe(false)
  })
})

describe("stripHistoricalMedia", () => {
  it("drops images from history and keeps the recent tail", () => {
    const messages: Row[] = [
      user("old one", [PNG]),
      assistant("old answer"),
      user("old two", [PNG]),
      assistant("recent answer"),
      user("current turn", [PNG]),
    ]
    const out = stripHistoricalMedia(messages)
    expect(out[0]?.images).toBeUndefined()
    expect(out[2]?.images).toBeUndefined()
    // The tail is what the user is still looking at.
    expect(out[4]?.images).toEqual([PNG])
  })

  it("never mutates the caller's messages", () => {
    const messages: Row[] = [user("old", [PNG]), assistant("a"), user("now", [PNG])]
    stripHistoricalMedia(messages)
    expect(messages[0]?.images).toEqual([PNG])
  })

  it("returns the same reference when there is nothing to strip", () => {
    const messages: Row[] = [user("plain"), assistant("a")]
    // Reference equality matters: the caller writes these into a request, and a
    // needless copy would churn the UI's render identity for no reason.
    expect(stripHistoricalMedia(messages)).toBe(messages)
  })

  it("honours an explicit window", () => {
    const messages: Row[] = [user("a", [PNG]), user("b", [PNG]), user("c", [PNG])]
    const out = stripHistoricalMedia(messages, 1)
    expect(out[0]?.images).toBeUndefined()
    expect(out[1]?.images).toBeUndefined()
    expect(out[2]?.images).toEqual([PNG])
  })

  it("strips everything when told to keep nothing", () => {
    const messages: Row[] = [user("a", [PNG]), user("b", [PNG])]
    const out = stripHistoricalMedia(messages, 0)
    expect(out.every((m) => m.images === undefined)).toBe(true)
  })

  it("defaults to a two-message tail", () => {
    expect(RECENT_MESSAGES_KEPT).toBe(2)
  })

  it("is safe on an empty session", () => {
    expect(stripHistoricalMedia([])).toEqual([])
  })

  it("actually removes the bytes that were being re-sent", () => {
    // The regression this exists for: base64 that kept riding along on every
    // request after the turns themselves had been compacted away.
    const messages: Row[] = [user("shot", [PNG]), assistant("noted"), user("follow up"), assistant("done")]
    expect(countInlineMedia(messages)).toBe(1)
    expect(countInlineMedia(stripHistoricalMedia(messages))).toBe(0)
  })
})

describe("countInlineMedia", () => {
  it("counts every message still carrying images", () => {
    const messages: Row[] = [user("a", [PNG]), assistant("x"), user("b", [PNG, PNG])]
    expect(countInlineMedia(messages)).toBe(2)
  })

  it("is zero for a text-only session", () => {
    expect(countInlineMedia([user("a"), assistant("b")])).toBe(0)
  })
})
