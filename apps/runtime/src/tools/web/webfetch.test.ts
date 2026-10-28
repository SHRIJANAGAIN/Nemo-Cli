/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * web_fetch — no sockets, ever.
 *
 * The tool fetches through node:http/https, so both modules are replaced
 * with a URL-routed stand-in. A route maps a URL substring to a canned
 * response: a string shorthand (200/text), an object with status/headers/
 * body (redirects, HTML, images, 4xx), an array (consumed in order — the
 * Cloudflare retry sees a different reply), `null` (transport error),
 * "res-error", or "req-timeout". Tests pin guards, format branches, the
 * 60s cache, redirect following, the Cloudflare bypass, clamps, and the
 * error envelopes — all deterministic. `sanitizeHtmlToMarkdown` is pure and
 * is exercised directly.
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../types.js"
import { createWebFetchTool, sanitizeHtmlToMarkdown } from "./webfetch.js"

type MockResponse =
  string | null | "res-error" | "req-timeout" | { status: number; headers?: Record<string, string>; body?: string }

/** Route table shared with the http(s) mocks (vi.hoisted → exists before the
 *  hoisted vi.mock factories and the imported tool module run). */
const net = vi.hoisted(() => {
  const routes = new Map<string, MockResponse | MockResponse[]>()
  const requests: string[] = []
  const requestHeaders: Array<Record<string, string>> = []
  const requestMethods: string[] = []
  const requestBodies: string[] = []
  return {
    routes,
    requests,
    requestHeaders,
    requestMethods,
    requestBodies,
    /** How many of the http(s) mock factories ran — never reset: if this
     *  stays 0 the suite would silently talk to the real network. */
    factoryHits: 0,
    reset(): void {
      routes.clear()
      requests.length = 0
      requestHeaders.length = 0
      requestMethods.length = 0
      requestBodies.length = 0
    },
    /** First matching route wins; arrays consume in order and repeat the
     *  last entry; unmatched URLs get an empty 200. */
    lookup(url: string): MockResponse {
      for (const [needle, value] of routes) {
        if (!url.includes(needle)) continue
        if (Array.isArray(value)) {
          if (value.length > 1) return value.shift() ?? ""
          return value[0] ?? ""
        }
        return value
      }
      return { status: 200, headers: { "content-type": "text/plain" }, body: "" }
    },
  }
})

interface MockReq extends EventEmitter {
  setTimeout(_ms: number, _cb?: () => void): MockReq
  write(_chunk: string): void
  end(): void
  destroy(): void
}

interface MockRes extends EventEmitter {
  statusCode?: number
  headers: Record<string, string>
  destroy(): void
}

/** node:http/https stand-in: no sockets, canned responses keyed by URL. */
function buildHttpModule(): { get: unknown; request: unknown } {
  const deliver = (url: string, onResp: (res: MockRes) => void, req: EventEmitter): void => {
    net.requests.push(url)
    setImmediate(() => {
      const spec = net.lookup(url)
      if (spec === null) {
        req.emit("error", new Error("ECONNREFUSED (mock transport)"))
        return
      }
      if (spec === "req-timeout") {
        req.emit("timeout")
        return
      }
      const res = new EventEmitter() as MockRes
      res.headers = {}
      res.destroy = (): void => {
        /* socket teardown is a no-op in the mock */
      }
      if (spec === "res-error") {
        onResp(res)
        res.emit("error", new Error("socket hang up (mock)"))
        return
      }
      const cfg: { status: number; headers?: Record<string, string>; body?: string } =
        typeof spec === "string" ? { status: 200, headers: { "content-type": "text/plain" }, body: spec } : spec
      res.statusCode = cfg.status
      res.headers = cfg.headers ?? {}
      const body = cfg.body ?? ""
      // Callback first: it reads statusCode/headers synchronously and
      // attaches its data/end listeners before the body is emitted.
      onResp(res)
      if (body.length > 0) res.emit("data", Buffer.from(body, "utf8"))
      res.emit("end")
    })
  }
  const makeReq = (url: string, onResp: (res: MockRes) => void, autoStart: boolean): MockReq => {
    const req = new EventEmitter() as MockReq
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      deliver(url, onResp, req)
    }
    req.setTimeout = (): MockReq => req
    req.write = (chunk: string): void => {
      /* request bodies are recorded so redirect/method semantics are testable */
      if (chunk !== "") net.requestBodies.push(String(chunk))
    }
    req.destroy = (): void => {
      /* teardown is a no-op: the scheduled deliver still runs */
    }
    req.end = start
    if (autoStart) start()
    return req
  }
  return {
    get: (rawUrl: unknown, _opts: unknown, onResp: (res: MockRes) => void): MockReq =>
      makeReq(String(rawUrl), onResp, /*autoStart*/ true),
    request: (
      opts: { hostname?: string; port?: number | string; path?: string; headers?: Record<string, string>; method?: string },
      onResp: (res: MockRes) => void,
    ): MockReq => {
      const port = opts.port ? `:${opts.port}` : ""
      const url = `http://${opts.hostname ?? "localhost"}${port}${opts.path ?? "/"}`
      net.requestHeaders.push(opts.headers ?? {})
      net.requestMethods.push(opts.method ?? "GET")
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

function textAt(result: ToolResult, index: number): string {
  const part = result.content[index]
  return part?.type === "text" ? part.text : ""
}

beforeEach(() => {
  net.reset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("web_fetch guards", () => {
  it("aborts before touching the network when the signal is already aborted", async () => {
    const tool = createWebFetchTool()
    const controller = new AbortController()
    controller.abort()
    const res = await tool.execute("t1", { url: "http://guard.test/x" }, controller.signal)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("aborted")
    expect(net.requests).toEqual([])
    // Both node:http and node:https must be routed through the canned mock —
    // anything else means the suite could hit the real network.
    expect(net.factoryHits).toBeGreaterThanOrEqual(2)
  })

  it("rejects a missing url", async () => {
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", {}, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Missing 'url'.")
    expect(net.requests).toEqual([])
  })

  it("rejects malformed and non-http urls", async () => {
    const tool = createWebFetchTool()
    const malformed = await tool.execute("t1", { url: "not a url" }, undefined)
    expect(firstText(malformed)).toBe("Invalid URL: not a url")
    const ftp = await tool.execute("t1", { url: "ftp://files.example/x" }, undefined)
    expect(firstText(ftp)).toBe("URL must start with http:// or https://")
    expect(net.requests).toEqual([])
  })
})

describe("web_fetch link-local and redirect policy (#73/#74)", () => {
  it("refuses a cloud-metadata URL before touching the transport", async () => {
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://169.254.169.254/latest/meta-data/" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("link-local")
    expect(net.requests).toEqual([])
  })

  it("refuses a redirect that pivots into link-local space", async () => {
    net.routes.set("/pivot", { status: 302, headers: { location: "http://169.254.169.254/steal" }, body: "" })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/pivot" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("Redirect blocked")
    expect(net.requests).toHaveLength(1)
  })

  it("fails cleanly on a malformed redirect location instead of crashing", async () => {
    net.routes.set("/bad", { status: 302, headers: { location: "http://[" }, body: "" })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/bad" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("Invalid redirect location")
  })
})

describe("web_fetch response handling", () => {
  it("sanitizes an HTML page and formats it as markdown text", async () => {
    net.routes.set("/page", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<h1>Title</h1><p>Hello <b>world</b> &amp; friends</p><script>evil()</script>",
    })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/page" }, undefined)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("HTTP 200 GET http://site.test/page")
    expect(text).toContain("Title")
    expect(text).toContain("Hello world & friends")
    expect(text).not.toContain("<h1>")
    expect(text).not.toContain("evil()")
    expect(text).not.toContain("(cached)")
  })

  it("keeps the body as-is for format=html", async () => {
    net.routes.set("/htmlpage", {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h1>Headline Four</h1>",
    })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/htmlpage", format: "html" }, undefined)
    // format=html promises the raw page, not the stripped text
    expect(firstText(res)).toContain("<h1>Headline Four</h1>")
  })

  it("runs the sanitizer for format=text on HTML", async () => {
    net.routes.set("/textpage", {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h1>Text Headline</h1>",
    })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/textpage", format: "text" }, undefined)
    expect(firstText(res)).toContain("Text Headline")
    expect(firstText(res)).not.toContain("<h1>")
  })

  it("passes non-HTML bodies through untouched", async () => {
    net.routes.set("/api", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true,"n":1}',
    })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/api" }, undefined)
    expect(firstText(res)).toContain('{"ok":true,"n":1}')
  })

  it("returns image bodies as base64 data parts", async () => {
    net.routes.set("/img.png", {
      status: 200,
      headers: { "content-type": "image/png" },
      body: "PNGDATA",
    })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/img.png" }, undefined)
    expect(firstText(res)).toContain("Image fetched successfully")
    expect(firstText(res)).toContain("mime: image/png")
    expect(textAt(res, 1)).toBe(`data:image/png;base64,${Buffer.from("PNGDATA", "binary").toString("base64")}`)
    expect(res.isError).toBe(false)
  })

  it("flags HTTP error statuses", async () => {
    net.routes.set("/missing", { status: 404, headers: { "content-type": "text/plain" }, body: "nope" })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/missing" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("HTTP 404 GET http://site.test/missing")
  })

  it("sends parsed custom headers with the request", async () => {
    net.routes.set("/hdr", "ok")
    const tool = createWebFetchTool()
    const res = await tool.execute(
      "t1",
      { url: "http://site.test/hdr", headers: JSON.stringify({ "X-Test": "yes" }) },
      undefined,
    )
    expect(res.isError).toBe(false)
    expect(net.requestHeaders[0]["X-Test"]).toBe("yes")
    expect(net.requestHeaders[0]["User-Agent"]).toContain("nemo")
  })

  it("survives a malformed headers JSON blob", async () => {
    net.routes.set("/badhdr", "ok")
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/badhdr", headers: "{not json" }, undefined)
    expect(res.isError).toBe(false)
    expect(net.requestHeaders[0]["X-Test"]).toBeUndefined()
  })

  it("truncates oversized bodies at max_bytes", async () => {
    net.routes.set("/long", "A".repeat(500))
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/long", max_bytes: 100 }, undefined)
    expect(firstText(res)).toContain("[truncated to 100 bytes]")
  })

  it("decodes &#96; and &#x60; as a backtick, not an apostrophe", async () => {
    net.routes.set("/bt", { status: 200, headers: { "content-type": "text/html" }, body: "a&#96;b &#x60;c" })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/bt", format: "text" }, undefined)
    expect(res.isError).toBe(false)
    expect(firstText(res)).toContain("a`b `c")
  })
})

describe("web_fetch cache", () => {
  it("serves a fresh 200 GET from the cache on the second call", async () => {
    net.routes.set("/cached", "fresh body")
    const tool = createWebFetchTool()
    const first = await tool.execute("t1", { url: "http://site.test/cached" }, undefined)
    expect(firstText(first)).not.toContain("(cached)")
    const second = await tool.execute("t1", { url: "http://site.test/cached" }, undefined)
    expect(firstText(second)).toContain("(cached)")
    expect(firstText(second)).toContain("HTTP 200 GET http://site.test/cached")
    expect(net.requests.filter((u) => u.includes("/cached"))).toHaveLength(1)
  })

  it("bypasses the cache when cache_ttl_ms is 0", async () => {
    net.routes.set("/nocache", "always fresh")
    const tool = createWebFetchTool()
    await tool.execute("t1", { url: "http://site.test/nocache", cache_ttl_ms: 0 }, undefined)
    const second = await tool.execute("t1", { url: "http://site.test/nocache", cache_ttl_ms: 0 }, undefined)
    expect(firstText(second)).not.toContain("(cached)")
    expect(net.requests.filter((u) => u.includes("/nocache"))).toHaveLength(2)
  })

  it("uppercases the method and never caches POSTs", async () => {
    net.routes.set("/hook", "hooked")
    const tool = createWebFetchTool()
    const first = await tool.execute("t1", { url: "http://site.test/hook", method: "post" }, undefined)
    expect(firstText(first)).toContain("HTTP 200 POST http://site.test/hook")
    const second = await tool.execute("t1", { url: "http://site.test/hook", method: "post" }, undefined)
    expect(firstText(second)).not.toContain("(cached)")
    expect(net.requests.filter((u) => u.includes("/hook"))).toHaveLength(2)
  })

  it("never serves a cache entry to a call with a different format", async () => {
    net.routes.set("/fmt-cache", {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<p>Formatted</p>",
    })
    const tool = createWebFetchTool()
    const html = await tool.execute("t1", { url: "http://site.test/fmt-cache", format: "html" }, undefined)
    expect(firstText(html)).toContain("<p>Formatted</p>")
    const markdown = await tool.execute("t1", { url: "http://site.test/fmt-cache", format: "markdown" }, undefined)
    expect(markdown.isError).toBe(false)
    expect(firstText(markdown)).not.toContain("(cached)")
    expect(net.requests.filter((u) => u.includes("/fmt-cache"))).toHaveLength(2)
  })

  it("never serves a cached response to a call with different headers", async () => {
    net.routes.set("/authed", "secret data")
    const tool = createWebFetchTool()
    const one = await tool.execute(
      "t1",
      { url: "http://site.test/authed", headers: '{"Authorization":"Bearer s3cr3t"}' },
      undefined,
    )
    expect(firstText(one)).toContain("secret data")
    // An anonymous call must not receive the body fetched with credentials.
    const two = await tool.execute("t1", { url: "http://site.test/authed" }, undefined)
    expect(firstText(two)).not.toContain("(cached)")
    expect(net.requests.filter((u) => u.includes("/authed"))).toHaveLength(2)
  })

  it("never serves a cached truncated body to a call asking for more bytes", async () => {
    net.routes.set("/big-cache", "A".repeat(300))
    const tool = createWebFetchTool()
    await tool.execute("t1", { url: "http://site.test/big-cache", max_bytes: 50 }, undefined)
    const two = await tool.execute("t1", { url: "http://site.test/big-cache", max_bytes: 200 }, undefined)
    expect(firstText(two)).not.toContain("(cached)")
    expect(net.requests.filter((u) => u.includes("/big-cache"))).toHaveLength(2)
  })
})

describe("web_fetch redirects, retries, and failures", () => {
  it("follows a redirect and reports the final url", async () => {
    net.routes.set("/first", { status: 302, headers: { location: "/second" }, body: "" })
    net.routes.set("/second", { status: 200, headers: { "content-type": "text/plain" }, body: "landed here" })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://redir.test/first" }, undefined)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("landed here")
    expect(text).toContain("http://redir.test/second")
    expect(net.requests.filter((u) => u.includes("/first") || u.includes("/second"))).toHaveLength(2)
  })

  it("retries a Cloudflare challenge with a different User-Agent", async () => {
    net.routes.set("/cfpage", [
      {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        body: "<html>challenge page</html>",
      },
      { status: 200, headers: { "content-type": "text/html" }, body: "<p>finally bypassed</p>" },
    ])
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://cf.test/cfpage" }, undefined)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("HTTP 200 GET http://cf.test/cfpage")
    expect(text).toContain("finally bypassed")
    expect(net.requests.filter((u) => u.includes("/cfpage"))).toHaveLength(2)
    expect(net.requestHeaders[1]["User-Agent"]).toBe("nemo")
  })

  it("clamps timeout to 120 seconds and surfaces the timeout error", async () => {
    net.routes.set("/slow", "req-timeout")
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/slow", timeout: 9999 }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Request failed: Request timed out after 120s")
  })

  it("rejects responses above the 5MB content-length limit", async () => {
    net.routes.set("/huge", {
      status: 200,
      headers: { "content-type": "text/plain", "content-length": "9999999999" },
      body: "x",
    })
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/huge" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Request failed: Response too large (exceeds 5MB limit)")
  })

  it("wraps a transport error", async () => {
    net.routes.set("/down", null)
    const tool = createWebFetchTool()
    const res = await tool.execute("t1", { url: "http://site.test/down" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Request failed: ECONNREFUSED (mock transport)")
  })

  it("resolves as aborted when the signal fires mid-flight", async () => {
    net.routes.set("/slowpage", { status: 200, headers: { "content-type": "text/html" }, body: "<p>hi</p>" })
    const tool = createWebFetchTool()
    const controller = new AbortController()
    const pending = tool.execute("t1", { url: "http://abort.test/slowpage" }, controller.signal)
    controller.abort()
    const res = await pending
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("aborted")
  })

  it("downgrades to GET and drops the body on 301/302/303 redirects", async () => {
    net.routes.set("/redir", { status: 302, headers: { location: "/dest" }, body: "redirect-page" })
    net.routes.set("/dest", { status: 200, headers: { "content-type": "text/plain" }, body: "ok" })
    const tool = createWebFetchTool()
    const res = await tool.execute(
      "t1",
      { url: "http://site.test/redir", method: "POST", body: "payload" },
      undefined,
    )
    expect(res.isError).toBe(false)
    expect(firstText(res)).toContain("ok")
    // The follow-up hop must be a GET with no request body — not a POST that
    // replays the redirect response page as its payload.
    expect(net.requestMethods).toEqual(["POST", "GET"])
    expect(net.requestBodies).toEqual(["payload"])
  })

  it("preserves method and body on 307/308 redirects", async () => {
    net.routes.set("/keeps", { status: 307, headers: { location: "/dest2" }, body: "redirect-page" })
    net.routes.set("/dest2", { status: 200, headers: { "content-type": "text/plain" }, body: "ok" })
    const tool = createWebFetchTool()
    const res = await tool.execute(
      "t1",
      { url: "http://site.test/keeps", method: "PUT", body: "data" },
      undefined,
    )
    expect(res.isError).toBe(false)
    expect(net.requestMethods).toEqual(["PUT", "PUT"])
    expect(net.requestBodies).toEqual(["data", "data"])
  })
})

describe("sanitizeHtmlToMarkdown", () => {
  it("converts headings, links, lists, and code blocks and decodes entities", () => {
    const md = sanitizeHtmlToMarkdown(
      '<h2>Sec</h2><p>See <a href="https://x.example">link</a> about R&amp;D</p>' +
        "<ul><li>one</li><li>two</li></ul><pre><code>const a = 1</code></pre>",
    )
    expect(md).toContain("## Sec")
    expect(md).toContain("[link](https://x.example)")
    expect(md).toContain("R&D")
    expect(md).toContain("- one")
    expect(md).toContain("- two")
    expect(md).toContain("const a = 1")
    expect(md.startsWith("```")).toBe(false)
    expect(md).not.toContain("<")
  })
})
