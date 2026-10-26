/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * End-to-end proof that a picture actually reaches the endpoint.
 *
 * The unit tests in vision.test.ts pin the transform; these pin the bytes on
 * the wire, against a local stub — no network. A vision feature that is
 * correct in isolation but never serialized is invisible until a real endpoint
 * rejects the request, which is exactly the failure mode worth catching here.
 */
import { describe, expect, it } from "vitest"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { createNvidiaProvider } from "./nvidia.js"
import { createOllamaProvider } from "./ollama.js"
import { createLlamaCppProvider } from "./llama-cpp.js"
import type { ChatInput } from "./types.js"

const PNG = "data:image/png;base64,iVBORw0KGgo="

const SSE = 'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n' + "data: [DONE]\n\n"

async function captureBody(make: (baseUrl: string) => { chat: (i: ChatInput) => Promise<unknown> }, input: ChatInput) {
  let captured: Record<string, unknown> | null = null
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => {
      raw += c
    })
    req.on("end", () => {
      captured = JSON.parse(raw) as Record<string, unknown>
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.end(SSE)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await make(`http://127.0.0.1:${port}`).chat(input)
  } finally {
    server.close()
  }
  if (!captured) throw new Error("stub saw no request")
  return captured as Record<string, unknown>
}

function bodyMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.messages as Array<Record<string, unknown>>
}

const withImage: ChatInput = {
  system: "sys",
  messages: [{ role: "user", content: "describe this", images: [PNG] }],
}

const textOnly: ChatInput = {
  system: "sys",
  messages: [{ role: "user", content: "hi" }],
}

describe("OpenAI-compatible vision on the wire", () => {
  it("sends the image as an OpenAI image_url content part", async () => {
    const body = await captureBody(
      (url) => createOllamaProvider({ baseUrl: url, model: "llama3.1" }),
      withImage,
    )

    const user = bodyMessages(body)[1]!
    expect(Array.isArray(user.content)).toBe(true)
    const parts = user.content as Array<Record<string, unknown>>
    expect(parts[0]).toEqual({ type: "text", text: "describe this" })
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: PNG } })
  }, 15000)

  it("does not also send the sibling images field", async () => {
    const body = await captureBody(
      (url) => createOllamaProvider({ baseUrl: url, model: "llama3.1" }),
      withImage,
    )
    // A backend that forwards unknown keys would otherwise send the raw data
    // URL twice, inflating the request and confusing strict validators.
    expect(bodyMessages(body)[1]).not.toHaveProperty("images")
  }, 15000)

  it("keeps the system prompt as a plain string row", async () => {
    const body = await captureBody(
      (url) => createOllamaProvider({ baseUrl: url, model: "llama3.1" }),
      withImage,
    )
    expect(bodyMessages(body)[0]).toEqual({ role: "system", content: "sys" })
  }, 15000)

  it("leaves a text-only conversation completely unchanged", async () => {
    const body = await captureBody(
      (url) => createOllamaProvider({ baseUrl: url, model: "llama3.1" }),
      textOnly,
    )
    // The regression that matters most: 100% of existing traffic must serialize
    // exactly as before, so no current conversation changes meaning.
    expect(bodyMessages(body)[1]).toEqual({ role: "user", content: "hi" })
  }, 15000)

  it("works the same through the nvidia provider (ollama and custom inherit it)", async () => {
    const body = await captureBody((url) => createNvidiaProvider({ baseUrl: url, model: "m" }), withImage)
    const parts = bodyMessages(body)[1]!.content as Array<Record<string, unknown>>
    expect(parts.some((p) => p.type === "image_url")).toBe(true)
  }, 15000)

  it("works through llama.cpp, which has its own body builder", async () => {
    // llama-cpp does NOT inherit nvidia's buildBody — it duplicates it. Missing
    // this one would have made vision silently dead for every local model.
    const body = await captureBody((url) => createLlamaCppProvider({ baseUrl: url, model: "m" }), withImage)
    const parts = bodyMessages(body)[1]!.content as Array<Record<string, unknown>>
    expect(parts.some((p) => p.type === "image_url")).toBe(true)
  }, 15000)

  it("keeps a tool_call row on the string shape even when images are present", async () => {
    // An image part on role:"tool" is rejected outright, so this must never
    // widen regardless of what the caller passes.
    const input: ChatInput = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "view_image", arguments: "{}" } }],
        },
        { role: "tool", content: "a.png", tool_call_id: "c1", images: [PNG] },
      ],
    }
    const body = await captureBody((url) => createOllamaProvider({ baseUrl: url, model: "m" }), input)
    const toolRow = bodyMessages(body).find((m) => m.role === "tool")!
    expect(toolRow.content).toBe("a.png")
  }, 15000)
})
