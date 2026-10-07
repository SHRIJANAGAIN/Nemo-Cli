/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { createLlamaCppProvider } from "./llama-cpp.js"

interface Snapshot {
  req: EventEmitter
  res: EventEmitter & { statusCode?: number; headers?: Record<string, string> }
}

/** Captured https.request invocations so the test can drive sockets by hand. */
const net = vi.hoisted(() => {
  const snapshots: Snapshot[] = []
  return {
    snapshots,
    reset(): void {
      snapshots.length = 0
    },
  }
})

vi.mock("node:https", async () => {
  const { EventEmitter: MockEE } = await import("node:events")
  return {
    Agent: class Agent {},
    request: (
      _opts: Record<string, unknown>,
      onResponse?: (res: EventEmitter & { statusCode?: number; headers?: Record<string, string> }) => void,
    ): EventEmitter & { end(): void; destroy(): void } => {
      const req = new MockEE() as EventEmitter & { end(): void; destroy(): void }
      const res = new MockEE() as EventEmitter & { statusCode?: number; headers?: Record<string, string> }
      res.statusCode = 200
      res.headers = {}
      ;(res as EventEmitter & { setEncoding(_enc: string): void }).setEncoding = (): void => {}
      net.snapshots.push({ req, res })
      // Real https.request never invokes the response callback synchronously;
      // the provider relies on that (it clears a `firstByteTimer` declared
      // after the request is created). Defer to the microtask queue.
      queueMicrotask(() => onResponse?.(res))
      req.end = (): void => {
        /* body is irrelevant — the test drives events directly */
      }
      req.destroy = (): void => {
        /* no-op: the request object is a plain EventEmitter */
      }
      return req
    },
  }
})

const transientError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })

describe("provider transient-error retry vs the first-byte watchdog", () => {
  beforeEach(() => {
    net.reset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("a retried request is not killed by the first attempt's stale watchdog", async () => {
    const p = createLlamaCppProvider({ baseUrl: "https://provider.test", model: "m" })
    const pending = p.chat({ messages: [{ role: "user", content: "hi" }] })

    // Attempt 1 dies with a transient socket error before any response → the
    // provider schedules one silent retry (250 ms later).
    net.snapshots[0].req.emit("error", transientError)
    await vi.advanceTimersByTimeAsync(250)
    expect(net.snapshots).toHaveLength(2)

    // The retry only answers once the ORIGINAL attempt's 60 s first-byte
    // watchdog would have fired. That watchdog belongs to attempt 1 and must
    // be cleared when the retry starts; a stale one rejects the outer promise
    // mid-stream and discards the healthy retried answer.
    await vi.advanceTimersByTimeAsync(59_750)

    net.snapshots[1].res.emit(
      "data",
      'data: {"choices":[{"delta":{"content":"late answer"},"index":0}]}\n\n' +
        'data: {"choices":[{"finish_reason":"stop","index":0}]}\n\n',
    )
    net.snapshots[1].res.emit("end")

    const msg = await pending
    const text = msg.content.find((c) => c.type === "text")
    expect(text && "text" in text ? text.text : "").toBe("late answer")
  })
})