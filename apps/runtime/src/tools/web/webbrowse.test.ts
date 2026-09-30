/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * web_browse — no sockets, ever.
 *
 * The tool fetches through node:http/https, so both modules are replaced
 * with a URL-routed stand-in (string shorthand, {status,headers,body}
 * objects, `null` transport error, "res-error" response error).
 *
 * The tool keeps ONE module-level browser session (currentUrl, history,
 * cookies, pages), so the session tests run as a declared journey: guards
 * that need an empty session come first, then open → back → refresh →
 * follow_link. The follow_link test pins the fix for the dead-anchor bug
 * (links must come from the raw html captured at store time — the stored
 * body is sanitized, so re-parsing it found zero `<a>` tags), and the
 * malformed-location test pins the fix for the uncaught throw that could
 * take the process down on a hostile 302.
 */

import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../types.js"
import { createWebBrowseTool } from "./webbrowse.js"

type MockResponse = string | null | "res-error" | { status: number; headers?: Record<string, string>; body?: string }

/** Route table shared with the http(s) mocks (vi.hoisted → exists before the
 *  hoisted vi.mock factories and the imported tool module run). */
const net = vi.hoisted(() => {
  const routes = new Map<string, MockResponse | MockResponse[]>()
  const requests: string[] = []
  const requestHeaders: Array<Record<string, string>> = []
  return {
    routes,
    requests,
    requestHeaders,
    /** How many of the http(s) mock factories ran — never reset: if this
     *  stays 0 the suite would silently talk to the real network. */
    factoryHits: 0,
    reset(): void {
      routes.clear()
      requests.length = 0
      requestHeaders.length = 0
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
  end(): void
  destroy(): void
}

interface MockRes extends EventEmitter {
  statusCode?: number
  headers: Record<string, string>
  setEncoding(_enc: string): void
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
      const res = new EventEmitter() as MockRes
      res.headers = {}
      res.setEncoding = (): void => {
        /* chunks are emitted as Buffers; `buf += chunk` coerces to utf8 */
      }
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
      // attaches its data/end/error listeners before the body is emitted.
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
      opts: { hostname?: string; port?: number | string; path?: string; headers?: Record<string, string> },
      onResp: (res: MockRes) => void,
    ): MockReq => {
      const port = opts.port ? `:${opts.port}` : ""
      const url = `http://${opts.hostname ?? "localhost"}${port}${opts.path ?? "/"}`
      net.requestHeaders.push(opts.headers ?? {})
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

const DOCS_HTML =
  "<html><head><title>Docs Home</title></head><body>" +
  "<h1>Docs Home</h1><p>Welcome to the docs about R&amp;D.</p>" +
  '<a href="#top">top</a> <a href="javascript:void(0)">js</a> <a href="mailto:a@b.c">mail</a> ' +
  '<a href="/guide">Guide</a> <a href="/guide">Guide dup</a> ' +
  '<a href="ftp://f.example/x">ftplink</a> <a href="https://other.test/">Other</a>' +
  "</body></html>"

const GUIDE_HTML =
  "<html><head><title>Guide</title></head><body><h1>Guide Page</h1>" +
  '<a href="/step1">Step 1</a><a href="/step2">Step 2</a></body></html>'

function docsPage(): MockResponse {
  return {
    status: 200,
    headers: {
      "content-type": "text/html",
      "set-cookie": "sid=abc123; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
    },
    body: DOCS_HTML,
  }
}

beforeEach(() => {
  net.reset()
})

// The browser session is a module-level singleton: guards that need an
// empty session MUST run before any successful navigation below.
describe("web_browse guards (empty session)", () => {
  it("rejects refresh before any page is open", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "refresh" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("No page to refresh.")
    expect(net.requests).toEqual([])
  })

  it("rejects follow_link before any page is open", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "follow_link" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("No current page to follow links from.")
    expect(net.requests).toEqual([])
  })

  it("rejects go_back before any history exists", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "go_back" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("No previous pages in history.")
    expect(net.requests).toEqual([])
  })

  it("explains that go_forward needs open_url", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "go_forward" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Forward navigation requires re-requesting the URL. Use open_url with the desired URL.")
    expect(net.requests).toEqual([])
  })

  it("rejects a missing url", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Missing 'url'.")
    expect(net.requests).toEqual([])
  })

  it("rejects open_url without a url", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { action: "open_url" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Missing 'url' parameter for open_url.")
    expect(net.requests).toEqual([])
  })

  it("rejects malformed and non-http urls", async () => {
    const tool = createWebBrowseTool()
    const malformed = await tool.execute("t1", { url: "not a url" }, undefined)
    expect(firstText(malformed)).toBe("Invalid URL: not a url")
    const ftp = await tool.execute("t1", { url: "ftp://files.example/x" }, undefined)
    expect(firstText(ftp)).toBe('web_browse only supports http/https URLs (got "ftp:").')
    expect(net.requests).toEqual([])
  })

  it("refuses plain HTTP to untrusted hosts", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "http://evil.example/x" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain('Refusing to load plain-HTTP URL to untrusted host "evil.example"')
    expect(net.requests).toEqual([])
  })
})

describe("web_browse session journey", () => {
  it("opens an https page, filters junk anchors, and stores cookies", async () => {
    net.routes.set("/docs", docsPage())
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "https://docs.test/docs" }, undefined)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("HTTP 200 GET https://docs.test/docs")
    expect(text).toContain("Docs Home")
    expect(text).toContain("R&D")
    expect(net.factoryHits).toBeGreaterThanOrEqual(2)
    // Links: relative resolved, fragments/js/mail/ftp/duplicates dropped.
    expect(text).toContain("[links]")
    expect(text).toContain("- https://docs.test/guide  (Guide)")
    expect(text).toContain("- https://other.test/")
    expect((text.match(/- https:\/\/docs\.test\/guide/g) ?? []).length).toBe(1)
    expect(text).not.toContain("javascript:")
    expect(text).not.toContain("mailto:")
    expect(text).not.toContain("ftp://f.example")
    expect(text).not.toContain("#top")
  })

  it("reports go_back as a no-op while only one history entry exists", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "go_back" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("No previous pages in history.")
    expect(net.requests).toEqual([])
  })

  it("allows plain HTTP to loopback hosts and replays stored cookies", async () => {
    net.routes.set("/local", { status: 200, headers: { "content-type": "text/html" }, body: "<h1>Local</h1>" })
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "http://127.0.0.1/local" }, undefined)
    expect(firstText(res)).toContain("HTTP 200 GET http://127.0.0.1/local")
    expect(firstText(res)).toContain("Local")
    expect(net.requestHeaders.some((h) => h["Cookie"] === "sid=abc123")).toBe(true)
  })

  it("go_back revisits the previous page", async () => {
    net.routes.set("/docs", docsPage())
    net.routes.set("/local", { status: 200, headers: { "content-type": "text/html" }, body: "<h1>Local</h1>" })
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "go_back" }, undefined)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("HTTP 200 GET https://docs.test/docs")
    expect(text).not.toContain("http://127.0.0.1/local")
  })

  it("refresh re-requests the current url", async () => {
    net.routes.set("/docs", docsPage())
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "refresh" }, undefined)
    expect(firstText(res)).toContain("HTTP 200 GET https://docs.test/docs")
  })

  it("follow_link navigates to an anchor captured from the raw html", async () => {
    // Explicit text/html: the string shorthand would default to text/plain,
    // and links are only captured from html pages.
    net.routes.set("/guide", { status: 200, headers: { "content-type": "text/html" }, body: GUIDE_HTML })
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "follow_link", link_index: 0 }, undefined)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("HTTP 200 GET https://docs.test/guide")
    expect(text).toContain("Guide Page")
    expect(text).not.toContain("out of range")
  })

  it("follow_link rejects out-of-range indices", async () => {
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "", action: "follow_link", link_index: -1 }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Link index -1 out of range (0-1).")
    expect(net.requests).toEqual([])
  })

  it("open_url merges extra session headers into later requests", async () => {
    net.routes.set("/v1", "api ok")
    const tool = createWebBrowseTool()
    const res = await tool.execute(
      "t1",
      { action: "open_url", url: "https://api.test/v1", headers: JSON.stringify({ "X-Session": "on1" }) },
      undefined,
    )
    expect(firstText(res)).toContain("HTTP 200 GET https://api.test/v1")
    expect(net.requestHeaders.some((h) => h["X-Session"] === "on1")).toBe(true)
  })
})

describe("web_browse output shaping and failures", () => {
  it("ignores malformed header JSON on both open paths", async () => {
    net.routes.set("/h1", "one")
    net.routes.set("/h2", "two")
    const tool = createWebBrowseTool()
    const viaOpenUrl = await tool.execute(
      "t1",
      { action: "open_url", url: "https://h.test/h1", headers: "{bad" },
      undefined,
    )
    expect(firstText(viaOpenUrl)).toContain("HTTP 200 GET https://h.test/h1")
    const viaOpen = await tool.execute("t1", { url: "https://h.test/h2", headers: "{bad" }, undefined)
    expect(firstText(viaOpen)).toContain("HTTP 200 GET https://h.test/h2")
  })

  it("truncates the page at max_bytes", async () => {
    net.routes.set("/long", "X".repeat(300))
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "https://big.test/long", max_bytes: 50 }, undefined)
    expect(firstText(res)).toContain("[truncated to 50 bytes]")
  })

  it("omits the links section when with_links is false", async () => {
    net.routes.set("/nolinks", docsPage())
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "https://docs.test/nolinks", with_links: false }, undefined)
    expect(firstText(res)).toContain("Docs Home")
    expect(firstText(res)).not.toContain("[links]")
  })

  it("reports when an html page has no links", async () => {
    net.routes.set("/bare", { status: 200, headers: { "content-type": "text/html" }, body: "<h1>Nothing here</h1>" })
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "https://bare.test/bare" }, undefined)
    expect(firstText(res)).toContain("[links] none found on this page")
  })

  it("follows a redirect and reports the final url", async () => {
    net.routes.set("/r1", { status: 302, headers: { location: "/r2" }, body: "" })
    net.routes.set("/r2", { status: 200, headers: { "content-type": "text/html" }, body: "<h1>Landed</h1>" })
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "https://redir.test/r1" }, undefined)
    expect(firstText(res)).toContain("HTTP 200 GET https://redir.test/r2")
    expect(firstText(res)).toContain("Landed")
  })

  it("stops following redirects after the 5-hop cap", async () => {
    net.routes.set("/loop", { status: 302, headers: { location: "/loop" }, body: "" })
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "https://loop.test/loop" }, undefined)
    expect(res.isError).toBe(false)
    expect(firstText(res)).toContain("HTTP 302 GET https://loop.test/loop")
    expect(net.requests).toHaveLength(6)
  })

  it("fails cleanly on a malformed redirect location", async () => {
    net.routes.set("/bad", { status: 302, headers: { location: "http://[::bad" }, body: "" })
    const tool = createWebBrowseTool()
    const res = await tool.execute("t1", { url: "https://bad.test/bad" }, undefined)
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Invalid redirect location: http://[::bad")
  })

  it("wraps transport and response errors", async () => {
    net.routes.set("/down", null)
    net.routes.set("/broken", "res-error")
    const tool = createWebBrowseTool()
    const transport = await tool.execute("t1", { url: "https://down.test/down" }, undefined)
    expect(firstText(transport)).toBe("Request failed: ECONNREFUSED (mock transport)")
    const response = await tool.execute("t1", { url: "https://broken.test/broken" }, undefined)
    expect(firstText(response)).toBe("Response error: socket hang up (mock)")
  })

  it("attaches the abort listener without breaking the response", async () => {
    net.routes.set("/sig", { status: 200, headers: { "content-type": "text/html" }, body: "<p>still fine</p>" })
    const tool = createWebBrowseTool()
    const controller = new AbortController()
    controller.abort()
    const res = await tool.execute("t1", { url: "https://sig.test/sig" }, controller.signal)
    expect(res.isError).toBe(false)
    expect(firstText(res)).toContain("HTTP 200 GET https://sig.test/sig")
  })
})
