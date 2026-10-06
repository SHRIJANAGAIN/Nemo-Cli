/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { MAX_IMAGES_PER_MESSAGE, expandWireMessages, toContentParts } from "./vision.js"
import type { WireMessage } from "./types.js"

const PNG = "data:image/png;base64,iVBORw0KGgo="

describe("toContentParts", () => {
  it("leaves a text-only message as its exact original string", () => {
    const m: WireMessage = { role: "user", content: "hello" }
    expect(toContentParts(m)).toBe("hello")
  })

  it("preserves a null content when there is nothing to expand", () => {
    expect(toContentParts({ role: "assistant", content: null })).toBeNull()
  })

  it("expands a user message with an image into text + image_url parts", () => {
    const parts = toContentParts({ role: "user", content: "what is this?", images: [PNG] })
    expect(Array.isArray(parts)).toBe(true)
    const list = parts as Array<Record<string, unknown>>
    expect(list[0]).toEqual({ type: "text", text: "what is this?" })
    expect(list[1]).toEqual({ type: "image_url", image_url: { url: PNG } })
  })

  it("always leads with a text part, even when the message has no prose", () => {
    // Some gateways reject a parts array whose first element is not text.
    const parts = toContentParts({ role: "user", content: "", images: [PNG] }) as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ type: "text", text: "See the attached image." })
  })

  it("ignores images on non-user roles", () => {
    // A `tool` row cannot carry an image part on OpenAI-compatible endpoints,
    // and Session re-surfaces those as a user turn instead.
    expect(toContentParts({ role: "tool", content: "done", images: [PNG] })).toBe("done")
    expect(toContentParts({ role: "system", content: "sys", images: [PNG] })).toBe("sys")
    expect(toContentParts({ role: "assistant", content: "sure", images: [PNG] })).toBe("sure")
  })

  it("drops non-data and non-image payloads instead of forwarding them", () => {
    const parts = toContentParts({
      role: "user",
      content: "x",
      images: ["https://evil.example/pixel.png", "data:text/plain;base64,AAAA", PNG],
    }) as Array<Record<string, unknown>>
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(1)
  })

  it("caps the number of images rather than failing the turn", () => {
    const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 6 }, (_, i) => `data:image/png;base64,${i}`)
    const parts = toContentParts({ role: "user", content: "x", images: many }) as Array<Record<string, unknown>>
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(MAX_IMAGES_PER_MESSAGE)
  })

  it("treats an empty image list as text-only", () => {
    expect(toContentParts({ role: "user", content: "hi", images: [] })).toBe("hi")
  })
})

describe("expandWireMessages", () => {
  it("passes through a whole text-only conversation unchanged", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    const out = expandWireMessages(messages)
    expect(out).toEqual(messages)
    // Identity, not just deep equality: nothing should be reallocated on the
    // common path.
    expect(out[0]).toBe(messages[0])
    expect(out[1]).toBe(messages[1])
  })

  it("expands only the image-bearing user row and leaves its neighbours alone", () => {
    const out = expandWireMessages([
      { role: "user", content: "look" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "and this?", images: [PNG] },
    ])
    expect(out[0]!.content).toBe("look")
    expect(out[1]!.content).toBe("ok")
    expect(Array.isArray(out[2]!.content)).toBe(true)
  })

  it("strips the sibling images field so it cannot be double-encoded", () => {
    const out = expandWireMessages([{ role: "user", content: "look", images: [PNG] }])
    expect(out[0]).not.toHaveProperty("images")
  })

  it("keeps every other wire field intact through expansion", () => {
    const out = expandWireMessages([
      {
        role: "assistant",
        content: "text",
        tool_calls: [{ id: "c1", type: "function", function: { name: "n", arguments: "{}" } }],
      },
    ])
    expect(out[0]!.tool_calls).toHaveLength(1)
    expect(out[0]!.role).toBe("assistant")
  })

  it("preserves tool_call_id on tool rows", () => {
    const out = expandWireMessages([{ role: "tool", content: "result", tool_call_id: "c9" }])
    expect(out[0]!.tool_call_id).toBe("c9")
  })
})
