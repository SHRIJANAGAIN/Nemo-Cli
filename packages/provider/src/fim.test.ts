/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { createNvidiaProvider } from "./nvidia.js"
import { createCustomProvider } from "./custom.js"

/**
 * FIM over /v1/completions — deterministic via a local stub (no network).
 * Every OpenAI-compatible provider inherits fim() from NvidiaProvider.
 */

interface Captured {
  url: string
  body: Record<string, unknown>
}

function withStub(
  reply: (body: Record<string, unknown>) => { status: number; payload: unknown },
  run: (stubUrl: string) => Promise<void>,
): Promise<Captured> {
  return new Promise<Captured>((resolve, reject) => {
    let captured: Captured | null = null
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => {
        raw += c
      })
      req.on("end", () => {
        try {
          const body = JSON.parse(raw) as Record<string, unknown>
          captured = { url: req.url ?? "", body }
          const { status, payload } = reply(body)
          res.writeHead(status, { "Content-Type": "application/json" })
          res.end(JSON.stringify(payload))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      run(`http://127.0.0.1:${port}`).then(
        () => server.close(() => (captured ? resolve(captured) : reject(new Error("stub saw no request")))),
        (error) => server.close(() => reject(error instanceof Error ? error : new Error(String(error)))),
      )
    })
  })
}

describe("NvidiaProvider.fim", () => {
  it("posts prompt+suffix to /v1/completions and returns the text", async () => {
    const seen = await withStub(
      () => ({ status: 200, payload: { choices: [{ text: "middle();" }] } }),
      async (stubUrl) => {
        const provider = createNvidiaProvider({ baseUrl: stubUrl, model: "m" })
        const result = await provider.fim?.({ prompt: "function f() {", suffix: "}" })
        expect(result?.text).toBe("middle();")
      },
    )

    expect(seen.url).toBe("/v1/completions")
    expect(seen.body.prompt).toBe("function f() {")
    expect(seen.body.suffix).toBe("}")
    expect(seen.body.stream).toBe(false)
  }, 15000)

  it("omits an empty suffix and applies token/temperature defaults", async () => {
    const seen = await withStub(
      () => ({ status: 200, payload: { choices: [{ text: "x" }] } }),
      async (stubUrl) => {
        const provider = createNvidiaProvider({ baseUrl: stubUrl, model: "m" })
        await provider.fim?.({ prompt: "const x =" })
      },
    )

    expect(seen.body).not.toHaveProperty("suffix")
    expect(seen.body.max_tokens).toBe(256)
    expect(seen.body.temperature).toBe(0.2)
  }, 15000)

  it("clamps fim temperature to the backend ceiling", async () => {
    const seen = await withStub(
      () => ({ status: 200, payload: { choices: [{ text: "x" }] } }),
      async (stubUrl) => {
        const provider = createNvidiaProvider({ baseUrl: stubUrl, model: "m" })
        await provider.fim?.({ prompt: "const x =", temperature: 2.7 })
      },
    )
    expect(seen.body.temperature).toBe(2)
  }, 15000)

  it("rejects an empty prompt without a request", async () => {
    let calls = 0
    const server = http.createServer((_req, res) => {
      calls += 1
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("{}")
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const provider = createNvidiaProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "m" })
      await expect(provider.fim?.({ prompt: "" })).rejects.toThrow("FIM prompt must not be empty")
      expect(calls).toBe(0)
    } finally {
      server.close()
    }
  }, 15000)

  it("surfaces provider errors honestly", async () => {
    await withStub(
      () => ({ status: 400, payload: { error: "no completions here" } }),
      async (stubUrl) => {
        const provider = createNvidiaProvider({ baseUrl: stubUrl, model: "m" })
        await expect(provider.fim?.({ prompt: "x" })).rejects.toThrow("FIM returned 400")
      },
    )
  }, 15000)

  it("is inherited by OpenAI-compatible subclasses", async () => {
    await withStub(
      () => ({ status: 200, payload: { choices: [{ text: "y" }] } }),
      async (stubUrl) => {
        const provider = createCustomProvider({ baseUrl: stubUrl, model: "m" })
        expect(provider.id).toBe("custom")
        const result = await provider.fim?.({ prompt: "x" })
        expect(result?.text).toBe("y")
      },
    )
  }, 15000)
})
