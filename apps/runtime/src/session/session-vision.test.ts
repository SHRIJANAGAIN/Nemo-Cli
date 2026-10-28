/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Vision routing contract: how pictures reach the wire.
 *
 * The load-bearing detail is that a picture produced by a TOOL cannot ride on
 * its own `role: "tool"` row — no OpenAI-compatible endpoint accepts an image
 * part there. So it has to be re-surfaced as a synthetic user turn placed
 * immediately after that tool response. Get the placement wrong and either the
 * bytes never reach the model, or the tool_call/tool-result pairing breaks and
 * the endpoint 400s on the whole conversation.
 */
import { describe, expect, it } from "vitest"
import { Session } from "./session.js"
import { toolResultImages } from "../../../../packages/protocol/src/index.js"

const PNG = "data:image/png;base64,iVBORw0KGgo="
const JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="

function text(body: string): { type: "text"; text: string } {
  return { type: "text", text: body }
}

describe("Session.toWireMessages — user attachments", () => {
  it("carries a user image onto its own wire row", () => {
    const session = new Session()
    session.add({ role: "user", content: "what is this?", images: [PNG] })

    const wire = session.toWireMessages()
    expect(wire).toHaveLength(1)
    expect(wire[0]).toEqual({ role: "user", content: "what is this?", images: [PNG] })
  })

  it("leaves an ordinary user message exactly as it was", () => {
    // Regression guard for the shape-preservation promise: a text-only turn
    // must serialize byte-identically, or every saved conversation changes
    // meaning on replay.
    const session = new Session()
    session.add({ role: "user", content: "hello" })

    const wire = session.toWireMessages()
    expect(wire[0]).toEqual({ role: "user", content: "hello" })
    expect(wire[0]).not.toHaveProperty("images")
  })

  it("omits images entirely when the list is empty", () => {
    const session = new Session()
    session.add({ role: "user", content: "hello", images: [] })
    expect(session.toWireMessages()[0]).not.toHaveProperty("images")
  })

  it("drops a non-image payload instead of forwarding a foreign URL", () => {
    // A remote URL would make the endpoint fetch an attacker-chosen host on
    // every turn; a bare path is not readable by a backend at all.
    const session = new Session()
    session.add({
      role: "user",
      content: "look",
      images: ["https://evil.example/pixel.png", "/tmp/local.png", PNG],
    })

    expect(session.toWireMessages()[0]!.images).toEqual([PNG])
  })

  it("keeps multiple attachments in order", () => {
    const session = new Session()
    session.add({ role: "user", content: "compare", images: [PNG, JPG] })
    expect(session.toWireMessages()[0]!.images).toEqual([PNG, JPG])
  })
})

describe("Session.toWireMessages — tool-produced images", () => {
  /** assistant(tool_call) -> tool(result carrying a picture) */
  function withToolImage(images?: string[]): Session {
    const session = new Session()
    session.add({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "view_image", arguments: { path: "a.png" } }],
      stopReason: "tool_use",
    })
    session.add({
      role: "tool",
      toolCallId: "call_1",
      toolName: "view_image",
      content: [text("a.png (image/png) — attached below.")],
      isError: false,
      ...(images ? { images } : {}),
    })
    return session
  }

  it("never puts the image on the tool row itself", () => {
    // The core invariant. An image part on role:"tool" is rejected by every
    // OpenAI-compatible endpoint, so this must hold for any tool.
    const wire = withToolImage([PNG]).toWireMessages()
    const toolRow = wire.find((m) => m.role === "tool")
    expect(toolRow).toBeDefined()
    expect(toolRow).not.toHaveProperty("images")
    expect(typeof toolRow!.content).toBe("string")
  })

  it("re-surfaces the picture as a user turn immediately after the tool row", () => {
    const wire = withToolImage([PNG]).toWireMessages()
    expect(wire.map((m) => m.role)).toEqual(["assistant", "tool", "user"])

    const synthetic = wire[2]!
    expect(synthetic.role).toBe("user")
    expect(synthetic.images).toEqual([PNG])
    expect(synthetic.content).toContain("view_image")
  })

  it("keeps every tool_call answered before the synthetic user turn appears", () => {
    // Ordering is the whole game: OpenAI requires each assistant tool_calls id
    // to be answered by its tool row, and rejects the request otherwise.
    const session = new Session()
    session.add({
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "view_image", arguments: {} },
        { type: "toolCall", id: "c2", name: "view_image", arguments: {} },
      ],
      stopReason: "tool_use",
    })
    session.add({ role: "tool", toolCallId: "c1", toolName: "view_image", content: [text("one")], isError: false })
    session.add({
      role: "tool",
      toolCallId: "c2",
      toolName: "view_image",
      content: [text("two")],
      isError: false,
      images: [PNG],
    })

    const wire = session.toWireMessages()
    const answered = new Set(wire.filter((m) => m.role === "tool").map((m) => m.tool_call_id))
    expect(answered).toEqual(new Set(["c1", "c2"]))

    const firstUserAfterTools = wire.findIndex((m) => m.role === "user")
    const lastTool = wire.map((m) => m.role).lastIndexOf("tool")
    expect(firstUserAfterTools).toBeGreaterThan(lastTool)
  })

  it("adds no synthetic row for an ordinary tool result", () => {
    const session = new Session()
    session.add({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read_file", arguments: {} }],
      stopReason: "tool_use",
    })
    session.add({ role: "tool", toolCallId: "c1", toolName: "read_file", content: [text("file body")], isError: false })

    expect(session.toWireMessages().map((m) => m.role)).toEqual(["assistant", "tool"])
  })

  it("adds no synthetic row when the tool returned an empty image list", () => {
    expect(
      withToolImage([])
        .toWireMessages()
        .map((m) => m.role),
    ).toEqual(["assistant", "tool"])
  })

  it("discards a non-image payload from a tool result", () => {
    const wire = withToolImage(["https://evil.example/x.png", PNG]).toWireMessages()
    expect(wire[2]!.images).toEqual([PNG])
  })

  it("still carries the prose caption, so a text-only backend keeps the meaning", () => {
    const wire = withToolImage([PNG]).toWireMessages()
    expect(wire[1]!.content).toContain("image/png")
  })

  it("reports an error tool result without inventing a picture", () => {
    const session = new Session()
    session.add({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "view_image", arguments: {} }],
      stopReason: "tool_use",
    })
    session.add({
      role: "tool",
      toolCallId: "c1",
      toolName: "view_image",
      content: [text("Not a supported image")],
      isError: true,
    })

    expect(session.toWireMessages().map((m) => m.role)).toEqual(["assistant", "tool"])
  })
})

describe("toolResultImages", () => {
  it("returns an empty list when the field is absent or empty", () => {
    expect(toolResultImages({})).toEqual([])
    expect(toolResultImages({ images: [] })).toEqual([])
  })

  it("keeps only data:image payloads, in order", () => {
    expect(toolResultImages({ images: ["data:image/png;base64,AA", "nope", "data:text/plain;base64,BB"] })).toEqual([
      "data:image/png;base64,AA",
    ])
  })
})
