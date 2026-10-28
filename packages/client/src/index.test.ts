/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, it, expect } from "vitest"
import * as http from "http"
import type { AddressInfo } from "net"
import { NemoClient } from "./index.js"

/**
 * Round 11 attack: the client used to have NO timeout, NO response-byte cap,
 * and no error handling on the response stream — a hung or hostile local
 * server could wedge the TUI's /client slash handler forever (the promise
 * never settled) or grow `buf += chunk` without limit.
 */

const servers: http.Server[] = []

async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    // Node 19+ pools keep-alive sockets; close() alone would wait on them.
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const clientFor = (port: number, timeoutMs?: number): NemoClient =>
  new NemoClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs })

describe("NemoClient (HTTP)", () => {
  it("constructs with a default base URL", () => {
    // The constructor reads NEMO_SERVER_PORT at construction time.
    // When unset it defaults to 8787 — we only assert construction succeeds.
    expect(() => new NemoClient()).not.toThrow()
  })

  it("health() parses a valid response", async () => {
    const port = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ status: "ok", model: "m1" }))
    })
    await expect(clientFor(port).health()).resolves.toEqual({ status: "ok", model: "m1" })
  })

  it("run() delivers streamed SSE events in order", async () => {
    const port = await startServer((_req, res) => {
      res.setHeader("content-type", "text/event-stream")
      res.write('data: {"n":1}\n\n')
      res.write('data: {"n":2}\n\n')
      res.write("data: [DONE]\n\n")
      res.end()
    })
    const events: unknown[] = []
    await clientFor(port).run("hi", (e) => events.push(e))
    expect(events).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("run() rejects when the server accepts but never responds (timeout)", async () => {
    const port = await startServer(() => {
      /* accept the socket, then hang forever */
    })
    await expect(clientFor(port, 100).run("hi", () => undefined)).rejects.toThrow(/timed out after 100ms/)
  }, 10_000)

  it("health() rejects when the server accepts but never responds (timeout)", async () => {
    const port = await startServer(() => {
      /* hang */
    })
    await expect(clientFor(port, 100).health()).rejects.toThrow(/timed out after 100ms/)
  }, 10_000)

  it("run() rejects past the byte transport cap instead of buffering forever", async () => {
    const port = await startServer((_req, res) => {
      res.on("error", () => undefined) // client destroys mid-stream: expected
      // 17MB in one write with no frame boundary — the old client grew
      // `buf` past 16MB before this cap existed.
      res.write("x".repeat(17 * 1024 * 1024))
    })
    await expect(clientFor(port).run("hi", () => undefined)).rejects.toThrow(/byte transport cap/)
  }, 10_000)

  it("health() rejects a JSON body over its cap", async () => {
    const port = await startServer((_req, res) => {
      res.on("error", () => undefined)
      res.write('{"status":"')
      for (let i = 0; i < 4; i++) res.write("y".repeat(100 * 1024))
      res.write('"}')
      // never ends cleanly — the cap must trip first
    })
    await expect(clientFor(port).health()).rejects.toThrow(/byte transport cap/)
  }, 10_000)

  it("run() rejects when the response closes before completion", async () => {
    const port = await startServer((_req, res) => {
      res.write('data: {"partial":true}\n\n')
      res.destroy() // no 'end' ever arrives — old client awaited forever
    })
    await expect(clientFor(port, 5_000).run("hi", () => undefined)).rejects.toThrow(
      /closed before completion|aborted|ECONNRESET|hang up/,
    )
  }, 10_000)

  it("run() surfaces connection errors (server not listening)", async () => {
    const client = new NemoClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 5_000 })
    await expect(client.run("hi", () => undefined)).rejects.toThrow()
  })
})
