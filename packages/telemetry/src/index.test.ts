/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentEvent } from "../../protocol/src/index.js"
import { ConsoleTelemetry, NullTelemetry, createTelemetry, isTelemetryDisabled } from "./index.js"

/** An event carrying both credential-shaped material and ordinary long data. */
const eventWithSecret: AgentEvent = {
  type: "permission_request",
  id: "call-1",
  tool: "bash",
  args: {
    command: "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com/v1",
    apiKey: "sk-abcdefghijklmnop0123456789",
    cwd: "/home/someone/very/long/project/path/src/deeply/nested/index.ts",
  },
  reason: "confirm the outbound request",
}

const longPath = "/home/someone/very/long/project/path/src/deeply/nested/index.ts"

describe("ConsoleTelemetry", () => {
  let written: string[] = []

  beforeEach(() => {
    written = []
    delete process.env.TRAYAMBAK_TELEMETRY
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.TRAYAMBAK_TELEMETRY
  })

  it("debug mode writes REDACTED event detail to stderr", () => {
    process.env.TRAYAMBAK_TELEMETRY = "debug"
    new ConsoleTelemetry().capture(eventWithSecret)

    expect(written).toHaveLength(1)
    const line = written[0]
    expect(line).toContain("[telemetry] permission_request")
    // Credential material never reaches the line…
    expect(line).not.toContain("abc.def.ghi")
    expect(line).not.toContain("sk-abcdefghijklmnop0123456789")
    expect(line).not.toContain("Bearer abc.def")
    // …while the redaction markers and the ordinary long path survive intact.
    expect(line).toContain("[REDACTED]")
    expect(line).toContain("****")
    expect(line).toContain(longPath)
  })

  it("emits nothing to stderr outside debug mode", () => {
    new ConsoleTelemetry().capture(eventWithSecret)
    expect(written).toEqual([])
  })

  it("stays stderr-only — capture/flush never touch the network", () => {
    const fetchSpy = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
    try {
      process.env.TRAYAMBAK_TELEMETRY = "debug"
      const telemetry = new ConsoleTelemetry()
      telemetry.capture(eventWithSecret)
      telemetry.flush()
      expect(written.length).toBeGreaterThan(0)
      expect(written.every((line) => line.startsWith("[telemetry]"))).toBe(true)
      for (const line of written) expect(line).not.toContain("sk-abcdefghijklmnop0123456789")
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("flush reports the captured event count on stderr", () => {
    process.env.TRAYAMBAK_TELEMETRY = "debug"
    const telemetry = new ConsoleTelemetry()
    telemetry.capture(eventWithSecret)
    telemetry.capture({ type: "turn_start" })
    telemetry.flush()
    expect(written.some((line) => line.includes("captured 2 events"))).toBe(true)
    expect(written.some((line) => line.includes("[telemetry] turn_start"))).toBe(true)
  })
})

describe("NullTelemetry / createTelemetry", () => {
  let written: string[] = []

  beforeEach(() => {
    written = []
    delete process.env.TRAYAMBAK_TELEMETRY
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.TRAYAMBAK_TELEMETRY
  })

  it("NullTelemetry emits nothing, even in debug mode", () => {
    process.env.TRAYAMBAK_TELEMETRY = "debug"
    const telemetry = new NullTelemetry()
    telemetry.capture(eventWithSecret)
    telemetry.flush()
    expect(written).toEqual([])
    expect(telemetry.id).toBe("null")
  })

  it("createTelemetry(false) returns the silent sink and emits nothing", () => {
    process.env.TRAYAMBAK_TELEMETRY = "debug"
    const telemetry = createTelemetry(false)
    expect(telemetry).toBeInstanceOf(NullTelemetry)
    telemetry.capture(eventWithSecret)
    telemetry.flush()
    expect(written).toEqual([])
  })

  it("createTelemetry(true) returns the console sink", () => {
    expect(createTelemetry(true)).toBeInstanceOf(ConsoleTelemetry)
  })

  it("TRAYAMBAK_TELEMETRY=0 forces the null sink even when requested", () => {
    process.env.TRAYAMBAK_TELEMETRY = "0"
    expect(createTelemetry(true)).toBeInstanceOf(NullTelemetry)
    expect(isTelemetryDisabled()).toBe(true)
    delete process.env.TRAYAMBAK_TELEMETRY
    expect(isTelemetryDisabled()).toBe(false)
  })
})
