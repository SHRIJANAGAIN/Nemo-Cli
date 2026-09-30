/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * web_search (multi-provider) — no sockets, ever.
 *
 * The tool talks to the world through node:http/https, so both modules are
 * replaced with a URL-routed stand-in: tests register a canned body per URL
 * substring, anything unmatched resolves to "" (a provider that yields no
 * results), `null` simulates a transport error, and "res-error" a response
 * error. Assertions pin provider failover order, HTML/JSON parsing, dedupe,
 * the recency (year) guard, clamps, and output shaping — all deterministic.
 */

import { EventEmitter } from "node:events"
import os from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TrayambakConfig } from "../../config.js"
import type { ToolContext, ToolResult } from "../types.js"
import { createWebSearchTool, multiSearch } from "./multi-search.js"

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

function makeCtx(): ToolContext {
  return {
    cwd: os.tmpdir(),
    // Huge limits → truncateOutput passes text through untouched (and never
    // writes its home-dir truncation file inside tests).
    config: { maxOutputLines: 100_000, maxOutputBytes: 50_000_000 } as unknown as TrayambakConfig,
    permissions: { mode: "default", rules: [], askByDefault: false },
  }
}

function firstText(result: ToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : ""
}

function ddgHtml(items: Array<{ title: string; url: string; snippet: string }>): string {
  return items
    .map(
      (it) => `<a class="result__a" href="${it.url}">${it.title}</a>` + `<a class="result__snippet">${it.snippet}</a>`,
    )
    .join("\n")
}

function bingHtml(items: Array<{ title: string; url: string; snippet: string }>): string {
  return items
    .map((it) => `<li class="b_algo"><h2><a href="${it.url}">${it.title}</a></h2><p>${it.snippet}</p></li>`)
    .join("\n")
}

beforeEach(() => {
  net.reset()
  vi.stubEnv("HSEARCH_BASE_URL", "http://127.0.0.1:8000")
  vi.stubEnv("MOJEEK_API_KEY", "")
  vi.stubEnv("BRAVE_SEARCH_API_KEY", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("web_search guards", () => {
  it("aborts before touching the network when the signal is already aborted", async () => {
    const tool = createWebSearchTool()
    const controller = new AbortController()
    controller.abort()
    const res = await tool.execute("t1", { query: "anything" }, controller.signal, undefined, makeCtx())
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("aborted")
    expect(net.requests).toEqual([])
    // Both node:http and node:https must be routed through the canned mock —
    // anything else means the suite could hit the real network.
    expect(net.factoryHits).toBeGreaterThanOrEqual(2)
  })

  it("rejects a missing query", async () => {
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "   " }, undefined, undefined, makeCtx())
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Missing 'query'.")
    expect(net.requests).toEqual([])
  })
})

describe("query recency guard", () => {
  const nowYear = String(new Date().getFullYear())

  it("rewrites a stale year to the current year", async () => {
    net.routes.set("html.duckduckgo.com", "")
    const tool = createWebSearchTool()
    await tool.execute(
      "t1",
      { query: "best javascript frameworks 2020", provider: "duckduckgo" },
      undefined,
      undefined,
      makeCtx(),
    )
    const sentQuery = new URL(net.requests[0]).searchParams.get("q")
    expect(sentQuery).toBe(`best javascript frameworks ${nowYear}`)
  })

  it("appends the current year when the query asks for freshness but has none", async () => {
    net.routes.set("html.duckduckgo.com", "")
    const tool = createWebSearchTool()
    await tool.execute("t1", { query: "latest react updates", provider: "duckduckgo" }, undefined, undefined, makeCtx())
    expect(net.requests[0]).toContain(`latest%20react%20updates%20${nowYear}`)
  })

  it("keeps a recent year even when the query also asks for freshness", async () => {
    net.routes.set("html.duckduckgo.com", "")
    const tool = createWebSearchTool()
    await tool.execute("t1", { query: "latest vite 2025", provider: "duckduckgo" }, undefined, undefined, makeCtx())
    expect(net.requests[0]).toContain("latest%20vite%202025")
    expect(net.requests[0]).not.toContain(nowYear)
  })
})

describe("provider failover and parsing", () => {
  it("caps max_results at 10, parses DuckDuckGo HTML, and stops at the first provider that fills it", async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      title: i === 0 ? "<b>Rust</b> &amp; Ownership" : `Result ${i}`,
      url: `https://r.example/${i}`,
      snippet: i === 0 ? "Borrow &lt;checker&gt; &amp; lifetimes".padEnd(200, ".") : `Snippet ${i}`.padEnd(200, "."),
    }))
    net.routes.set("html.duckduckgo.com", ddgHtml(items))
    const tool = createWebSearchTool()
    const res = await tool.execute(
      "t1",
      { query: "rust ownership", provider: "duckduckgo", max_results: 99 },
      undefined,
      undefined,
      makeCtx(),
    )
    expect(firstText(res)).toContain("Found 10 results")
    expect(firstText(res)).toContain("Rust & Ownership")
    expect(firstText(res)).toContain("Borrow <checker> & lifetimes")
    expect(firstText(res)).toContain("[DUCKDUCKGO]")
    // The first provider filled the quota → hsearch/POST must never run.
    expect(net.requests).toHaveLength(1)
    expect(net.requests[0]).toContain("html.duckduckgo.com")
  })

  it("honours a max_results floor of 1", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://r.example/${i}`,
      snippet: "s",
    }))
    net.routes.set("html.duckduckgo.com", ddgHtml(items))
    const tool = createWebSearchTool()
    const res = await tool.execute(
      "t1",
      { query: "rust ownership", provider: "duckduckgo", max_results: 0 },
      undefined,
      undefined,
      makeCtx(),
    )
    expect(firstText(res)).toContain("Found 1 results")
  })

  it("posts to the hsearch endpoint and maps its JSON (url from link, snippet from description)", async () => {
    net.routes.set(
      "8000/search",
      JSON.stringify({ results: [{ title: "H1", link: "https://h.example/1", description: "desc one" }] }),
    )
    const results = await multiSearch("distributed cache", 3, "hsearch")
    expect(net.requests[0]).toBe("http://127.0.0.1:8000/search")
    expect(results[0]).toEqual({
      title: "H1",
      url: "https://h.example/1",
      snippet: "desc one",
      source: "hsearch",
    })
  })

  it("maps hsearch fallback keys (name/link/content) and untitles bare records", async () => {
    net.routes.set(
      "8000/search",
      JSON.stringify({ data: [{ name: "Fallback", link: "https://f.example", content: "body text" }, {}] }),
    )
    const results = await multiSearch("x", 5, "hsearch")
    expect(results[0]).toEqual({
      title: "Fallback",
      url: "https://f.example",
      snippet: "body text",
      source: "hsearch",
    })
    expect(results[1].title).toBe("(untitled)")
  })

  it("maps the Wikipedia API payload (synthesized URL, tag-stripped snippet)", async () => {
    net.routes.set(
      "en.wikipedia.org",
      JSON.stringify({
        query: { search: [{ title: "Rust (language)", snippet: '<span class="nowrap">foo</span> bar baz' }] },
      }),
    )
    const results = await multiSearch("rust language", 3, "wikipedia")
    expect(results[0].title).toBe("Rust (language)")
    expect(results[0].url).toBe("https://en.wikipedia.org/wiki/Rust%20(language)")
    expect(results[0].snippet).toBe("foo bar baz")
    expect(results[0].source).toBe("wikipedia")
  })

  it("dedupes identical URLs across providers and groups the output by source", async () => {
    net.routes.set(
      "html.duckduckgo.com",
      ddgHtml([
        { title: "Dup", url: "https://dup.example/same", snippet: "first wins" },
        { title: "Only DDG", url: "https://d.example/b", snippet: "b" },
      ]),
    )
    net.routes.set(
      "bing.com/search",
      bingHtml([
        { title: "Dup again", url: "https://dup.example/same", snippet: "dupe" },
        { title: "Bing C", url: "https://b.example/c", snippet: "c" },
        { title: "Bing D", url: "https://b.example/d", snippet: "d" },
      ]),
    )
    const tool = createWebSearchTool()
    const res = await tool.execute("t1", { query: "failover demo" }, undefined, undefined, makeCtx())
    const text = firstText(res)
    expect(text).toContain("Found 4 results from 2 providers")
    expect(text.indexOf("Only DDG")).toBeLessThan(text.indexOf("Bing C"))
    expect(text.match(/Dup again/g)).toBeNull()
  })

  it("falls back to the default order for an unknown preferred provider", async () => {
    const tool = createWebSearchTool()
    await tool.execute("t1", { query: "no provider", provider: "nonexistent" }, undefined, undefined, makeCtx())
    expect(net.requests[0]).toContain("8000/search")
  })

  it("treats a transport error as no results", async () => {
    net.routes.set("html.duckduckgo.com", null)
    const tool = createWebSearchTool()
    const res = await tool.execute(
      "t1",
      { query: "obscure thing", provider: "duckduckgo" },
      undefined,
      undefined,
      makeCtx(),
    )
    expect(firstText(res)).toBe('No web results for "obscure thing".')
  })

  it("treats a response error as no results", async () => {
    net.routes.set("html.duckduckgo.com", "res-error")
    const tool = createWebSearchTool()
    const res = await tool.execute(
      "t1",
      { query: "obscure thing", provider: "duckduckgo" },
      undefined,
      undefined,
      makeCtx(),
    )
    expect(firstText(res)).toBe('No web results for "obscure thing".')
  })
})

describe("additional provider parsers", () => {
  it("parses Google /url?q= redirects with VwiC3b snippets and skips google-internal links", async () => {
    net.routes.set(
      "google.com/search",
      '<a href="/url?q=https://www.google.com/intl&amp;sa=U">Google Internal</a>' +
        '<a href="/url?q=https%3A%2F%2Fgo.example%2Fx&amp;sa=U">Google Title</a>' +
        '<span class="VwiC3b">google snippet</span>',
    )
    const results = await multiSearch("q", 3, "google")
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: "Google Title",
      url: "https://go.example/x",
      snippet: "google snippet",
      source: "google",
    })
  })

  it("parses Qwant result__link anchors", async () => {
    net.routes.set(
      "qwant.com/?q",
      '<a class="result__link" href="https://qw.example/r">Qwant Result</a>' +
        '<p class="result__snippet">q snippet</p>',
    )
    const results = await multiSearch("q", 3, "qwant")
    expect(results[0]).toEqual({
      title: "Qwant Result",
      url: "https://qw.example/r",
      snippet: "q snippet",
      source: "qwant",
    })
  })

  it("falls back to generic anchors when Qwant has no result markup", async () => {
    net.routes.set("qwant.com/?q", '<a href="https://notqwant.example/page">Interesting Page Here</a>')
    const results = await multiSearch("q", 3, "qwant")
    expect(results[0]).toEqual({
      title: "Interesting Page Here",
      url: "https://notqwant.example/page",
      snippet: "",
      source: "qwant",
    })
  })

  it("parses Ecosia result anchors (href before class)", async () => {
    net.routes.set(
      "ecosia.org/search",
      '<a href="https://eco.example/r" class="result__link">Eco Result</a>' +
        '<p class="result__snippet">eco snippet</p>',
    )
    const results = await multiSearch("q", 3, "ecosia")
    expect(results[0]).toEqual({
      title: "Eco Result",
      url: "https://eco.example/r",
      snippet: "eco snippet",
      source: "ecosia",
    })
  })

  it("parses Baidu landurl anchors and skips baidu-internal links", async () => {
    net.routes.set(
      "baidu.com/s",
      '<a href="https://www.baidu.com/link?url=x" data-landurl="x">Baidu Internal</a>' +
        '<a href="https://bd.example/p" data-landurl="y">Baidu Result</a>' +
        '<span class="content-right_abc">baidu snippet</span>',
    )
    const results = await multiSearch("q", 3, "baidu")
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: "Baidu Result",
      url: "https://bd.example/p",
      snippet: "baidu snippet",
      source: "baidu",
    })
  })

  it("parses Yandex link anchors and skips yandex-internal links", async () => {
    net.routes.set(
      "yandex.com/search",
      '<a href="https://yandex.com/some" class="link">Yandex Internal</a>' +
        '<a href="https://yx.example/p" class="link">Yandex Result</a>' +
        '<div class="text">y snippet</div>',
    )
    const results = await multiSearch("q", 3, "yandex")
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: "Yandex Result",
      url: "https://yx.example/p",
      snippet: "y snippet",
      source: "yandex",
    })
  })

  it("parses Naver link anchors with desc snippets", async () => {
    net.routes.set(
      "search.naver.com",
      '<a href="https://nv.example/p" class="link">Naver Result</a><p class="desc">n snippet</p>',
    )
    const results = await multiSearch("q", 3, "naver")
    expect(results[0]).toEqual({
      title: "Naver Result",
      url: "https://nv.example/p",
      snippet: "n snippet",
      source: "naver",
    })
  })

  it("parses the arXiv Atom feed", async () => {
    net.routes.set(
      "export.arxiv.org/api",
      "<entry><title>Attention Is All You Need</title>" +
        "<id>http://arxiv.org/abs/1706.03762</id>" +
        "<summary>The dominant sequence transduction models.</summary></entry>",
    )
    const results = await multiSearch("attention", 3, "arxiv")
    expect(results[0]).toEqual({
      title: "Attention Is All You Need",
      url: "http://arxiv.org/abs/1706.03762",
      snippet: "The dominant sequence transduction models.",
      source: "arxiv",
    })
  })

  it("parses GitHub repository search links with the owner separator intact", async () => {
    net.routes.set(
      "github.com/search",
      '<a class="Link Link--primary" href="/octocat/hello-world">Hello World Repo</a>',
    )
    const results = await multiSearch("hello", 3, "github")
    expect(results[0]).toEqual({
      title: "Hello World Repo",
      url: "https://github.com/octocat/hello-world",
      snippet: "GitHub repository",
      source: "github",
    })
  })

  it("parses StackOverflow search items with score and answered state", async () => {
    net.routes.set(
      "api.stackexchange.com",
      JSON.stringify({
        items: [{ title: "How to exit", link: "https://stackoverflow.com/q/1", score: 5, is_answered: true }],
      }),
    )
    const results = await multiSearch("exit", 3, "stackoverflow")
    expect(results[0]).toEqual({
      title: "How to exit",
      url: "https://stackoverflow.com/q/1",
      snippet: "Score: 5 | Answered: Yes",
      source: "stackoverflow",
    })
  })

  it("parses Mojeek result-link anchors (HTML path)", async () => {
    net.routes.set(
      "mojeek.com/search",
      '<a class="result-link" href="https://mj.example/r">Mojeek Result</a>' +
        '<p class="result-description">mj snippet</p>',
    )
    const results = await multiSearch("q", 3, "mojeek")
    expect(results[0]).toEqual({
      title: "Mojeek Result",
      url: "https://mj.example/r",
      snippet: "mj snippet",
      source: "mojeek",
    })
  })

  it("uses the Mojeek JSON API when an API key is configured", async () => {
    vi.stubEnv("MOJEEK_API_KEY", "mj-key")
    net.routes.set(
      "api.mojeek.com/search",
      JSON.stringify({ results: [{ title: "API Result", url: "https://api.example/r", description: "api snippet" }] }),
    )
    const results = await multiSearch("q", 3, "mojeek")
    expect(results[0]).toEqual({
      title: "API Result",
      url: "https://api.example/r",
      snippet: "api snippet",
      source: "mojeek",
    })
  })

  it("parses Brave HTML results with data-result-type anchors", async () => {
    net.routes.set(
      "search.brave.com/search",
      '<a href="https://br.example/p" data-result-type="web">Brave Result</a>' +
        '<div class="snippet-description">br snippet</div>',
    )
    const results = await multiSearch("q", 3, "brave")
    expect(results[0]).toEqual({
      title: "Brave Result",
      url: "https://br.example/p",
      snippet: "br snippet",
      source: "brave",
    })
  })

  it("uses the Brave JSON API when an API key is configured", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "br-key")
    net.routes.set(
      "api.search.brave.com",
      JSON.stringify({
        web: { results: [{ title: "JSON Result", url: "https://json.example/r", snippet: "json snippet" }] },
      }),
    )
    const results = await multiSearch("q", 3, "brave")
    expect(results[0]).toEqual({
      title: "JSON Result",
      url: "https://json.example/r",
      snippet: "json snippet",
      source: "brave",
    })
  })

  it("drops a non-JSON Brave API response instead of crashing", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "br-key")
    net.routes.set("api.search.brave.com", "<html>gateway timeout</html>")
    const results = await multiSearch("q", 3, "brave")
    expect(results).toEqual([])
  })
})

describe("output shaping", () => {
  const bigDdg = (): string =>
    ddgHtml(
      Array.from({ length: 15 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://r.example/${i}`,
        snippet: `Snippet for result ${i} `.repeat(12),
      })),
    )

  it("leaves output under the default context cap alone", async () => {
    net.routes.set("html.duckduckgo.com", bigDdg())
    const tool = createWebSearchTool()
    const res = await tool.execute(
      "t1",
      { query: "rust ownership", provider: "duckduckgo" },
      undefined,
      undefined,
      makeCtx(),
    )
    const text = firstText(res)
    expect(text).toContain("Found 10 results")
    expect(text).not.toContain("[truncated to")
    expect(text).not.toContain("[output truncated")
  })

  it("clamps context_max_characters to 1000 and marks the truncation", async () => {
    net.routes.set("html.duckduckgo.com", bigDdg())
    const tool = createWebSearchTool()
    const res = await tool.execute(
      "t1",
      { query: "rust ownership", provider: "duckduckgo", context_max_characters: 10 },
      undefined,
      undefined,
      makeCtx(),
    )
    const text = firstText(res)
    expect(text).toContain("[truncated to 1000 characters for LLM context]")
    expect(text.indexOf("[truncated to 1000")).toBe(
      text.length - "[truncated to 1000 characters for LLM context]".length,
    )
  })
})
