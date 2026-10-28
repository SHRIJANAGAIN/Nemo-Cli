/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Network-outage detection and auto-resume (#124).
 *
 * The transient-retry budget is 5 restarts inside 120s. That is generous for a
 * gateway blip and far too small for reality: a laptop that sleeps on a train,
 * a VPN that re-authenticates, a captive-portal wifi that drops for three
 * minutes. In every one of those cases the run used to die with a raw provider
 * error EVEN THOUGH the network came back — the user watched a working
 * session die and had to re-ask everything.
 *
 * The distinction that matters is between a SERVER problem and a LOCAL
 * NETWORK problem. A 429 or a 503 clears on its own schedule and the existing
 * backoff is right for it. A refused socket means nothing is answering until
 * the interface comes back, and retrying into it just burns the budget.
 *
 * Every test here runs against a REAL loopback HTTP server or a REAL refused
 * port — no external network, no stubbed sockets.
 */
import * as http from "http"
import type { AddressInfo } from "net"
import { afterEach, describe, expect, it } from "vitest"
import { isNetworkOutage, waitForNetwork } from "./network-recovery.js"

/** Resolve once `predicate` holds, with a hard ceiling so a bug cannot hang CI. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("isNetworkOutage", () => {
  it("recognises the socket-level failures that mean the interface is down", () => {
    for (const raw of [
      "connect ECONNREFUSED 127.0.0.1:443",
      "read ECONNRESET",
      "socket hang up",
      "getaddrinfo ENOTFOUND api.example.com",
      "connect ETIMEDOUT 10.0.0.1:443",
      "getaddrinfo EAI_AGAIN api.example.com",
      "network is unreachable",
      "Connection closed before response",
    ]) {
      expect(isNetworkOutage(raw), raw).toBe(true)
    }
  })

  it("does NOT claim a server-side condition is a local outage", () => {
    for (const raw of [
      "429 too many requests",
      "503 Service Unavailable",
      "500 internal server error",
      "401 invalid api key",
      "context_length_exceeded",
      "model overloaded",
    ]) {
      expect(isNetworkOutage(raw), raw).toBe(false)
    }
  })

  it("treats an HTTP status as a server problem even when the text says timeout", () => {
    // "Request timed out after 60000ms" from a gateway is a SERVER timeout.
    // Classifying it as a local outage would park the run waiting for a
    // network that is demonstrably fine.
    expect(isNetworkOutage("504 Gateway Timeout")).toBe(false)
    expect(isNetworkOutage("408 Request Timeout")).toBe(false)
  })
})

describe("waitForNetwork", () => {
  const servers: http.Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  })

  async function liveServer(): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  /** A port nothing listens on: a real refused connection. */
  async function deadPort(): Promise<string> {
    const probe = http.createServer()
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((r) => probe.close(() => r()))
    return `http://127.0.0.1:${port}`
  }

  it("resolves immediately when the network is already reachable", async () => {
    const url = await liveServer()
    const started = Date.now()
    const outcome = await waitForNetwork({ probeUrl: url, intervalMs: 20, timeoutMs: 2_000 })
    expect(outcome).toBe("restored")
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it("keeps polling a dead endpoint and reports a timeout instead of hanging", async () => {
    const url = await deadPort()
    let probes = 0
    const outcome = await waitForNetwork({
      probeUrl: url,
      intervalMs: 20,
      timeoutMs: 300,
      onProbe: () => {
        probes++
      },
    })
    expect(outcome).toBe("timeout")
    // It must actually have retried rather than declaring failure up front.
    expect(probes).toBeGreaterThan(1)
  })

  it("reports restoration the moment the endpoint answers again", async () => {
    const url = await deadPort()
    let calls = 0
    const pending = waitForNetwork({
      probeUrl: url,
      intervalMs: 15,
      timeoutMs: 5_000,
      onProbe: () => {
        calls++
        // Bring the endpoint back after the second failed attempt.
        if (calls === 2) void liveServerOnPort(url)
      },
    })
    const outcome = await pending
    expect(outcome).toBe("restored")
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  async function liveServerOnPort(target: string): Promise<void> {
    const { port } = new URL(target)
    const server = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end("ok")
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(Number(port), "127.0.0.1", () => r()))
    await until(() => server.listening)
  }

  it("aborts promptly instead of sleeping out the whole timeout", async () => {
    const url = await deadPort()
    const controller = new AbortController()
    const started = Date.now()
    const pending = waitForNetwork({ probeUrl: url, intervalMs: 5_000, timeoutMs: 60_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 40)
    const outcome = await pending
    expect(outcome).toBe("aborted")
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("surfaces the first state transition exactly once", async () => {
    const url = await liveServer()
    const states: string[] = []
    await waitForNetwork({
      probeUrl: url,
      intervalMs: 20,
      timeoutMs: 2_000,
      onState: (s) => states.push(s),
    })
    expect(states).toEqual(["restored"])
  })
})
