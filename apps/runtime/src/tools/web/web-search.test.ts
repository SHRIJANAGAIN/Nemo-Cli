/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * web_search (hsearch direct) — no sockets, ever.
 *
 * This tool posts to HSEARCH_BASE_URL through node:http/https, so both
 * modules are replaced with a URL-routed stand-in (canned body per endpoint
 * substring; `null` = transport error; "res-error" = response error). Tests
 * pin endpoint routing, every formatResults shape (search/browse/timeline/
 * JSON fallback), the non-JSON guard, and the error envelopes — all
 * deterministic. The module is currently unreferenced by the registry; these
 * tests keep its contract alive.
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../types.js"
import { createWebSearchTool } from "./web-search.js"

/** Route table shared with the http(s) mocks (vi.hoisted → exists before the
 *  hoisted vi.mock factories and the imported tool module run). */
const net = vi.hoisted(() => {
  const routes = new Map<string, string | null>()
  const requests: string[] = []
  return {
    routes,
    requests,
    /** How many of the http(s) mock factories ran — never reset: if this
     *  stays 0 the suite would silently talk to the real network. */
    factoryHits: 0,
    reset(): void {
      routes.clear()
      requests.length = 0
    },
    /** First matching route wins; unmatched URLs return "" (empty response). */
    lookup(url: string): string | null {
      for (const [needle, body] of routes) {
        if (url.includes(needle)) return body
      }
      return ""
    },
  }
})

interface MockReq extends EventEmitter {
  setTimeout(_ms: number, _cb?: () => void): MockReq
  write(_chunk: string): void
  end(): void
}

/** node:http/https stand-in: no sockets, canned bodies keyed by URL. */
function buildHttpModule(): { get: unknown; request: unknown } {
  const deliver = (url: string, onResp: (res: EventEmitter) => void, req: EventEmitter): void => {
    net.requests.push(url)
    setImmediate(() => {
      const body = net.lookup(url)
      if (body === null) {
        req.emit("error", new Error("ECONNREFUSED (mock transport)"))
        return
      }
      const res = new EventEmitter()
      onResp(res)
      if (body === "res-error") {
        res.emit("error", new Error("socket hang up (mock)"))
        return
      }
      if (body.length > 0) res.emit("data", Buffer.from(body))
      res.emit("end")
    })
  }
  const makeReq = (url: string, onResp: (res: EventEmitter) => void, autoStart: boolean): MockReq => {
    const req = new EventEmitter() as MockReq
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      deliver(url, onResp, req)
    }
    req.setTimeout = (): MockReq => req
    req.write = (): void => {
      /* body is irrelevant — routing is URL-based */
    }
    req.end = start
    if (autoStart) start()
    return req
  }
  return {
    get: (rawUrl: unknown, _opts: unknown, onResp: (res: EventEmitter) => void): MockReq =>
      makeReq(String(rawUrl), onResp, /*autoStart*/ true),
    request: (
      opts: { hostname?: string; port?: number | string; path?: string },
      onResp: (res: EventEmitter) => void,
    ): MockReq => {
      const port = opts.port ? `:${opts.port}` : ""
      const url = `http://${opts.hostname ?? "localhost"}${port}${opts.path ?? "/"}`
      return makeReq(url, onResp, /*autoStart*/ false)
    },
  }
}

vi.mock("https", () => {
  net.factoryHits++
  const api = buildHttpModule()
  // `default` serves `import https from "https"`; the spread serves
  // `import * as https from "https"`.
  return { ...api, default: api }
})
vi.mock("http", () => {
  net.factoryHits++
  const api = buildHttpModule()
  return { ...api, default: api }
})

function firstText(result: ToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : ""
}

beforeEach(() => {
  net.reset()
  // createWebSearchTool() captures the base URL at construction time, so the
  // stub must land before every tool factory call in the tests below.
  vi.stubEnv("HSEARCH_BASE_URL", "http://127.0.0.1:8000")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("web_search guards", () => {
  it("rejects a missing query without touching the network", async () => {
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", {}, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Missing 'query'.")
    expect(net.requests).toEqual([])
    expect(net.factoryHits).toBeGreaterThanOrEqual(2)
  })
})

describe("web_search endpoint formats", () => {
  it("formats search results with scores, urls, and snippets", async () => {
    net.routes.set(
      "/search",
      JSON.stringify({
        results: [
          { title: "Alpha", url: "https://a.example", snippet: "about alpha", score: 0.9512 },
          { name: "Beta", link: "https://b.example", content: "about beta" },
        ],
      }),
    )
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "alpha beta" }, undefined)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(net.requests[0]).toBe("http://127.0.0.1:8000/search")
    expect(text).toContain('Top 2 results for "alpha beta"')
    expect(text).toContain("1. Alpha [0.951]")
    expect(text).toContain("https://a.example")
    expect(text).toContain("about alpha")
    expect(text).toContain("2. Beta")
    expect(text).toContain("https://b.example")
  })

  it("reads search results from the data fallback key", async () => {
    net.routes.set("/search", JSON.stringify({ data: [{ title: "Gamma", url: "https://g.example", snippet: "g" }] }))
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "gamma" }, undefined)
    expect(firstText(res)).toContain("Top 1 results")
    expect(firstText(res)).toContain("https://g.example")
  })

  it("reports an empty search result set", async () => {
    net.routes.set("/search", JSON.stringify({ results: [] }))
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "nothing here" }, undefined)
    expect(firstText(res)).toBe('No web results for "nothing here".')
  })

  it("caps browse output at 8 of the reported pages", async () => {
    net.routes.set(
      "/browse",
      JSON.stringify({
        pages: Array.from({ length: 10 }, (_, i) => ({
          title: `Page ${i}`,
          url: `https://p.example/${i}`,
          text: `body ${i}`,
        })),
      }),
    )
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "site", endpoint: "browse" }, undefined)
    const text = firstText(res)
    expect(net.requests[0]).toContain("/browse")
    expect(text).toContain('Browsed 10 pages for "site"')
    expect(text.match(/^- Page /gm)).toHaveLength(8)
    expect(text).not.toContain("Page 8")
  })

  it("reports empty browse output", async () => {
    net.routes.set("/browse", JSON.stringify({ pages: [] }))
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "ghost site", endpoint: "browse" }, undefined)
    expect(firstText(res)).toBe('No browsed pages for "ghost site".')
  })

  it("caps timeline output at 12 of the reported events", async () => {
    net.routes.set(
      "/timeline",
      JSON.stringify({
        events: Array.from({ length: 14 }, (_, i) => ({
          date: `2026-0${(i % 9) + 1}-01`,
          title: `Event ${i}`,
          snippet: `what happened ${i}`,
        })),
      }),
    )
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "release", endpoint: "timeline" }, undefined)
    const text = firstText(res)
    expect(text).toContain('Timeline for "release"')
    expect(text.match(/^\[\d{4}-\d{2}-\d{2}\] Event /gm)).toHaveLength(12)
    expect(text).toContain("—")
    expect(text).not.toContain("Event 12")
  })

  it("reports empty timeline output", async () => {
    net.routes.set("/timeline", JSON.stringify({ events: [] }))
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "quiet", endpoint: "timeline" }, undefined)
    expect(firstText(res)).toBe('No timeline events for "quiet".')
  })

  it("falls back to pretty-printed JSON for unknown endpoints", async () => {
    net.routes.set("/frobnicate", JSON.stringify({ weird: true }))
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "odd", endpoint: "frobnicate" }, undefined)
    expect(net.requests[0]).toContain("/frobnicate")
    expect(firstText(res)).toContain('"weird": true')
  })

  it("routes through node:https when the base URL is https", async () => {
    vi.stubEnv("HSEARCH_BASE_URL", "https://secure.example.test")
    // Match on the hostname only: the mock's synthesized URL inserts ":443"
    // between host and path, so a "host/path" needle would never hit.
    net.routes.set(
      "secure.example.test",
      JSON.stringify({ results: [{ title: "S", url: "https://s.example", snippet: "s" }] }),
    )
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "secure" }, undefined)
    expect(net.requests[0]).toContain("secure.example.test")
    expect(firstText(res)).toContain("https://s.example")
  })
})

describe("web_search error envelopes", () => {
  it("flags a non-JSON response with a body preview", async () => {
    net.routes.set("/search", "<html>gateway said no</html>")
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "x" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("Search service returned non-JSON:")
    expect(firstText(res)).toContain("<html>gateway said no</html>")
  })

  it("wraps a transport error", async () => {
    net.routes.set("/search", null)
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "x" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("web_search error: Request failed: ECONNREFUSED (mock transport)")
  })

  it("wraps a response error", async () => {
    net.routes.set("/search", "res-error")
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "x" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("web_search error: Response error: socket hang up (mock)")
  })
})

describe("web_search input and body guards", () => {
  it("rejects endpoint traversal before any request is sent", async () => {
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "x", endpoint: "../admin" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("Invalid 'endpoint'")
    expect(net.requests).toHaveLength(0)
  })

  it("stops reading an oversized service response", async () => {
    net.routes.set("/search", "x".repeat(2_000_001))
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "big" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("too large")
  })
})
