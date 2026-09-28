/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as http from "http"
import { ProviderManager, listModelNames } from "./manager.js"
import type { ProviderEntry } from "./registry.js"

const entry = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id: "p1",
  type: "openai",
  label: "OpenAI",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "test-key",
  ...over,
})

describe("ProviderManager registry operations", () => {
  it("starts empty and falls back to the first entry for active()", () => {
    const m = new ProviderManager()
    expect(m.list()).toEqual([])
    expect(m.active()).toBeUndefined()

    m.add(entry())
    expect(m.list().length).toBe(1)
    expect(m.get("p1")?.label).toBe("OpenAI")
    expect(m.get("missing")).toBeUndefined()
    expect(m.active()?.id).toBe("p1")
  })

  it("clears the active provider when the active entry is removed", () => {
    const m = new ProviderManager({ providers: [entry(), entry({ id: "p2" })] })
    expect(m.activate("p1")).not.toBeNull()
    expect(m.getActiveEntry()?.id).toBe("p1")

    expect(m.remove("p1")).toBe(true)
    expect(m.remove("p1")).toBe(false)
    expect(m.get("p1")).toBeUndefined()
    expect(m.getActiveEntry()).toBeNull()
    expect(m.getActiveProvider()).toBeNull()
  })

  it("activates a known provider and ignores unknown ids or types", () => {
    const m = new ProviderManager({ providers: [entry(), entry({ id: "p2", type: "bogus" })] })
    expect(m.activate("missing")).toBeNull()
    expect(m.getActiveEntry()).toBeNull()

    expect(m.activate("p1")).not.toBeNull()
    expect(m.getActiveEntry()?.id).toBe("p1")

    // Unknown factory: activation fails and the active provider stays put.
    expect(m.activate("p2")).toBeNull()
    expect(m.getActiveEntry()?.id).toBe("p1")
  })

  it("honors activeProviderId passed to the constructor", () => {
    const m = new ProviderManager({
      providers: [entry({ id: "a" }), entry({ id: "b" })],
      activeProviderId: "b",
    })
    expect(m.getActiveEntry()?.id).toBe("b")
  })

  it("exposes registered provider types case-insensitively", () => {
    const m = new ProviderManager()
    const types = m.supportedTypes()
    expect(types).toContain("openai")
    expect(types).toContain("ollama")
    expect(types).toContain("anthropic")
    expect(types.length).toBeGreaterThanOrEqual(9)
    expect(m.hasType("OPENAI")).toBe(true)
    expect(m.hasType("bogus")).toBe(false)
  })
})

describe("listModelNames against a local server", () => {
  let server: http.Server
  let port = 0
  let requests: Array<{ url?: string; auth?: string | string[] }> = []
  let respond: (res: http.ServerResponse) => void

  beforeEach(async () => {
    requests = []
    respond = (res) => {
      res.end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: 42 }] }))
    }
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization })
      respond(res)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    port = typeof address === "object" && address ? address.port : 0
  })

  afterEach(async () => {
    ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const url = (suffix = "") => `http://127.0.0.1:${port}${suffix}`

  it("strips trailing /v1/, sends auth, and returns string ids only", async () => {
    const ids = await listModelNames(url("/v1/"), "secret")
    expect(ids).toEqual(["m1", "m2"])
    expect(requests[0]?.url).toBe("/v1/models")
    expect(requests[0]?.auth).toBe("Bearer secret")
  })

  it("works with a bare base url and omits auth when no key is given", async () => {
    const ids = await listModelNames(url(), "")
    expect(ids).toEqual(["m1", "m2"])
    expect(requests[0]?.url).toBe("/v1/models")
    expect(requests[0]?.auth).toBeUndefined()
  })

  it("resolves [] when the payload has no usable ids", async () => {
    respond = (res) => res.end(JSON.stringify({ data: [] }))
    expect(await listModelNames(url(), "k")).toEqual([])

    respond = (res) => res.end(JSON.stringify({ data: [{ id: 7 }] }))
    expect(await listModelNames(url(), "k")).toEqual([])
  })

  it("resolves [] for a non-JSON payload", async () => {
    respond = (res) => res.end("not json at all")
    expect(await listModelNames(url(), "k")).toEqual([])
  })

  it("resolves [] when the connection is refused", async () => {
    // Grab a port that is definitely closed.
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const closedPort = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    expect(await listModelNames(`http://127.0.0.1:${closedPort}/v1`, "k")).toEqual([])
  })

  it("rejects non-http protocols", async () => {
    await expect(listModelNames("file:///tmp/models", "k")).rejects.toThrow("Invalid URL protocol: file:")
  })

  it("resolves [] when the server never responds", async () => {
    respond = () => {
      /* hold the request open until the client times out */
    }
    expect(await listModelNames(url(), "k")).toEqual([])
  }, 15_000)
})

describe("ProviderManager.fetchModels", () => {
  let server: http.Server
  let port = 0

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.end(JSON.stringify({ data: [{ id: "gpt-x" }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("fetches model names for a known entry and returns [] otherwise", async () => {
    const m = new ProviderManager({
      providers: [entry({ baseUrl: `http://127.0.0.1:${port}/v1` })],
    })
    expect(await m.fetchModels("p1")).toEqual(["gpt-x"])
    expect(await m.fetchModels("missing")).toEqual([])
  })
})
