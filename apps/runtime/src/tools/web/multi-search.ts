/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import https from "https"
import http from "http"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, truncateOutput } from "../types.js"
import { decodeEntities, stripTags } from "./html-text.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "web_search",
  description:
    "Search the web using multiple providers (hsearch, DuckDuckGo, Wiby, Mojeek, Bing, Brave, Qwant) with automatic failover. Returns ranked results with URLs, titles, snippets, and relevance scores. Use this BEFORE answering factual questions to ensure accuracy. IMPORTANT: always include the CURRENT year in your query (e.g. 'X latest updates " +
    new Date().getFullYear() +
    "'). Stale years are automatically corrected to the current year.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "integer", description: "Max results to return. Default 10. Max 10." },
      provider: {
        type: "string",
        description: "Preferred provider: auto, hsearch, duckduckgo, wiby, mojeek, bing, brave, qwant. Default auto.",
        enum: ["auto", "hsearch", "duckduckgo", "wiby", "mojeek", "bing", "brave", "qwant"],
      },
      context_max_characters: {
        type: "integer",
        description: "Maximum characters for context string optimized for LLMs. Default 10000.",
      },
    },
  },
}

type SearchResult = { title: string; url: string; snippet: string; source: string }

function fetchHtml(url: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === "https:" ? https : http
    const req = lib.get(
      url,
      {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        res.on("error", () => resolve(""))
      },
    )
    req.on("error", () => resolve(""))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve("")
    })
  })
}

function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 15000,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve) => {
    const parsed = new URL(url)
    const lib = parsed.protocol === "https:" ? https : http
    const data = JSON.stringify(body)
    const req = lib.request(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + (parsed.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Accept: "application/json",
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        res.on("error", () => resolve(""))
      },
    )
    req.on("error", () => resolve(""))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve("")
    })
    req.write(data)
    req.end()
  })
}

function stripHtml(html: string): string {
  return stripTags(html).replace(/\s+/g, " ").trim()
}

/** True only when the URL's host is `domain` or a subdomain of it. */
function hostMatches(rawUrl: string, domain: string): boolean {
  let host: string
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === domain || host.endsWith(`.${domain}`)
}

async function searchHsearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const baseUrl = (process.env.HSEARCH_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "")
  try {
    const raw = await postJson(`${baseUrl}/search`, { query, max_results: maxResults })
    if (!raw) return []
    const data = JSON.parse(raw) as Record<string, unknown>
    const results = (data.results ?? data.data ?? []) as Array<Record<string, unknown>>
    if (!Array.isArray(results)) return []
    return results.map((r) => ({
      title: String(r.title ?? r.name ?? "(untitled)"),
      url: String(r.url ?? r.link ?? ""),
      snippet: String(r.snippet ?? r.description ?? r.content ?? "").slice(0, 220),
      source: "hsearch",
    }))
  } catch {
    return []
  }
}

/** Real destination behind a DDG redirect link (`//duckduckgo.com/l/?uddg=<url>&rut=…`).
 *  Falls back to the href itself (protocol-relative → https). */
export function resolveDuckDuckGoHref(href: string): string {
  const withProto = href.startsWith("//") ? `https:${href}` : href
  const uddg = /[?&]uddg=([^&]+)/.exec(withProto)
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1])
    } catch {
      return uddg[1]
    }
  }
  return withProto
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encoded}`)
    if (!html) return []
    const results: SearchResult[] = []
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = resolveDuckDuckGoHref(decodeEntities(m[1]))
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "duckduckgo" })
      i++
    }
    return results
  } catch {
    return []
  }
}

async function searchMojeek(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const apiKey = process.env.MOJEEK_API_KEY
    const url = apiKey
      ? `https://api.mojeek.com/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&format=json&count=${maxResults}`
      : `https://www.mojeek.com/search?q=${encodeURIComponent(query)}&count=${maxResults}`
    const raw = await fetchHtml(url)
    if (!raw) return []
    if (apiKey) {
      try {
        const data = JSON.parse(raw) as Record<string, unknown>
        const results = (data.results ?? []) as Array<Record<string, unknown>>
        return results.map((r) => ({
          title: String(r.title ?? "(untitled)"),
          url: String(r.url ?? ""),
          snippet: String(r.snippet ?? r.description ?? "").slice(0, 220),
          source: "mojeek",
        }))
      } catch {
        return []
      }
    }
    const results: SearchResult[] = []
    const re = /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<p[^>]+class="result-description"[^>]*>([\s\S]*?)<\/p>/gi
    const snipMatches = Array.from(raw.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "mojeek" })
      i++
    }
    return results
  } catch {
    return []
  }
}

async function searchBing(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://www.bing.com/search?q=${encoded}&count=${maxResults * 2}`)
    if (!html) return []
    const results: SearchResult[] = []
    const re =
      /<li[^>]+class="b_algo"[^>]*>[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<\/li>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = decodeEntities(stripHtml(m[3]))
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "bing" })
    }
    if (results.length === 0) {
      const simpleRe =
        /<a[^>]+href="(https?:\/\/(?![^"]*(?:bing\.com|microsoft\.com|msn\.com))[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
      let sm: RegExpExecArray | null
      while ((sm = simpleRe.exec(html)) !== null && results.length < maxResults) {
        const href = decodeEntities(sm[1])
        const title = decodeEntities(stripHtml(sm[2]))
        if (title.length > 10 && !hostMatches(href, "bing.com"))
          results.push({ title, url: href, snippet: "", source: "bing" })
      }
    }
    return results
  } catch {
    return []
  }
}

async function searchBrave(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY
    if (apiKey) {
      const raw = await postJson(
        "https://api.search.brave.com/res/v1/web/search",
        { q: query, count: maxResults },
        15000,
        { Accept: "application/json", "X-Subscription-Token": apiKey },
      )
      if (!raw) return []
      try {
        const data = JSON.parse(raw) as Record<string, unknown>
        const webData = (data.web ?? data) as Record<string, unknown>
        const results = (webData.results ?? []) as Array<Record<string, unknown>>
        return results.map((r) => ({
          title: String(r.title ?? "(untitled)"),
          url: String(r.url ?? ""),
          snippet: String(r.description ?? r.snippet ?? "").slice(0, 220),
          source: "brave",
        }))
      } catch {
        return []
      }
    }
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://search.brave.com/search?q=${encoded}`)
    if (!html) return []
    const results: SearchResult[] = []
    const re =
      /<a[^>]+href="(https?:\/\/(?![^"]*(?:brave\.com))[^"]+)"[^>]+data-result-type="web"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<div[^>]+class="snippet-description"[^>]*>([\s\S]*?)<\/div>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "brave" })
      i++
    }
    return results
  } catch {
    return []
  }
}

async function searchQwant(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://www.qwant.com/?q=${encoded}&t=web`)
    if (!html) return []
    const results: SearchResult[] = []
    const re = /<a[^>]+class="[^"]*result__link[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<p[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/p>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "qwant" })
      i++
    }
    if (results.length === 0) {
      const genericRe = /<a[^>]+href="(https?:\/\/(?![^"]*(?:qwant\.com))[^"]+)"[^>]*>([\s\S]{5,200}?)<\/a>/gi
      let gm: RegExpExecArray | null
      while ((gm = genericRe.exec(html)) !== null && results.length < maxResults) {
        const href = decodeEntities(gm[1])
        const title = decodeEntities(stripHtml(gm[2]))
        if (title.length > 5 && !hostMatches(href, "qwant.com"))
          results.push({ title, url: href, snippet: "", source: "qwant" })
      }
    }
    return results
  } catch {
    return []
  }
}

async function searchGoogle(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://www.google.com/search?q=${encoded}&num=${maxResults * 2}`)
    if (!html) return []
    const results: SearchResult[] = []
    // Real Google markup appends tracking params after the target
    // (q=TARGET&amp;sa=U) — the closing quote must not be required directly
    // after the capture or nothing ever matches.
    const re = /<a[^>]+href="\/url\?q=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<span[^>]+class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(decodeURIComponent(m[1]))
      const title = decodeEntities(stripHtml(m[2]))
      if (!hostMatches(href, "google.com") && title.length > 3) {
        const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
        results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "google" })
        i++
      }
    }
    return results
  } catch {
    return []
  }
}

async function searchEcosia(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://www.ecosia.org/search?q=${encoded}`)
    if (!html) return []
    const results: SearchResult[] = []
    const re = /<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<p[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/p>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "ecosia" })
      i++
    }
    return results
  } catch {
    return []
  }
}

async function searchBaidu(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://www.baidu.com/s?wd=${encoded}&rn=${maxResults}`)
    if (!html) return []
    const results: SearchResult[] = []
    const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]+data-landurl[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<span[^>]+class="[^"]*content-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      if (hostMatches(href, "baidu.com")) continue
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "baidu" })
      i++
    }
    return results
  } catch {
    return []
  }
}

async function searchYandex(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://yandex.com/search/?text=${encoded}&num=${maxResults}`)
    if (!html) return []
    const results: SearchResult[] = []
    const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]+class="[^"]*link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<div[^>]+class="[^"]*text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      if (hostMatches(href, "yandex.com")) continue
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "yandex" })
      i++
    }
    return results
  } catch {
    return []
  }
}

async function searchNaver(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const html = await fetchHtml(`https://search.naver.com/search.naver?query=${encoded}`)
    if (!html) return []
    const results: SearchResult[] = []
    const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]+class="[^"]*link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
    const snipRe = /<p[^>]+class="[^"]*desc[^"]*"[^>]*>([\s\S]*?)<\/p>/gi
    const snipMatches = Array.from(html.matchAll(snipRe))
    let i = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const href = decodeEntities(m[1])
      const title = decodeEntities(stripHtml(m[2]))
      const snippet = i < snipMatches.length ? decodeEntities(stripHtml(snipMatches[i][1])) : ""
      if (hostMatches(href, "naver.com")) continue
      results.push({ title, url: href, snippet: snippet.slice(0, 220), source: "naver" })
      i++
    }
    return results
  } catch {
    return []
  }
}

async function searchWikipedia(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const raw = await fetchHtml(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encoded}&format=json&origin=*&srlimit=${maxResults}`,
    )
    if (!raw) return []
    const data = JSON.parse(raw) as Record<string, unknown>
    const queryData = data.query as Record<string, unknown> | undefined
    const search = (queryData?.search ?? []) as Array<Record<string, unknown>>
    return search.map((r) => ({
      title: String(r.title ?? "(untitled)"),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title ?? ""))}`,
      snippet: stripHtml(String(r.snippet ?? "")).slice(0, 220),
      source: "wikipedia",
    }))
  } catch {
    return []
  }
}

async function searchArxiv(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const raw = await fetchHtml(
      `https://export.arxiv.org/api/query?search_query=all:${encoded}&max_results=${maxResults}&sortBy=relevance`,
    )
    if (!raw) return []
    const results: SearchResult[] = []
    const re = /<entry>([\s\S]*?)<\/entry>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null && results.length < maxResults) {
      const entry = m[1]
      const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)
      const linkMatch = entry.match(/<id[^>]*>(.*?)<\/id>/)
      const summaryMatch = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)
      const title = titleMatch ? decodeEntities(stripHtml(titleMatch[1].trim())) : "(untitled)"
      const url = linkMatch ? decodeEntities(stripHtml(linkMatch[1].trim())) : ""
      const snippet = summaryMatch ? decodeEntities(stripHtml(summaryMatch[1].trim())).slice(0, 220) : ""
      results.push({ title, url, snippet, source: "arxiv" })
    }
    return results
  } catch {
    return []
  }
}

async function searchGitHub(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const raw = await fetchHtml(`https://github.com/search?q=${encoded}&type=repositories`, 15000)
    if (!raw) return []
    const results: SearchResult[] = []
    const re = /<a[^>]+class="[^"]*Link[^"]*"[^>]+href="\/([^"]+\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null && results.length < maxResults) {
      // The regex consumes the leading "/" outside the capture group, so it
      // must be re-added — without it every URL reads github.com<owner>/…
      const href = `https://github.com/${decodeEntities(m[1])}`
      const title = decodeEntities(stripHtml(m[2]))
      if (title.length > 3) results.push({ title, url: href, snippet: "GitHub repository", source: "github" })
    }
    return results
  } catch {
    return []
  }
}

/**
 * Wiby (wiby.me) — tiny index of classic/bot-friendly pages, but a REAL
 * keyless JSON API (`[{URL, Title, Snippet}]`), no scraping, no key, no
 * challenge pages. Proven live. Sits right behind DuckDuckGo: general
 * queries usually fill from DDG; when DDG challenges, Wiby still answers.
 */
async function searchWiby(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const raw = await fetchHtml(`https://wiby.me/json?q=${encodeURIComponent(query)}`)
    if (!raw) return []
    const data = JSON.parse(raw) as Array<Record<string, unknown>>
    if (!Array.isArray(data)) return []
    return data.slice(0, maxResults).map((r) => ({
      title: String(r.Title ?? r.title ?? "(untitled)"),
      url: String(r.URL ?? r.url ?? ""),
      snippet: String(r.Snippet ?? r.snippet ?? r.Description ?? "").slice(0, 220),
      source: "wiby",
    }))
  } catch {
    return []
  }
}

async function searchStackOverflow(query: string, maxResults: number): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query)
    const raw = await fetchHtml(
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encoded}&site=stackoverflow&pagesize=${maxResults}`,
      15000,
    )
    if (!raw) return []
    const data = JSON.parse(raw) as Record<string, unknown>
    const items = (data.items ?? []) as Array<Record<string, unknown>>
    return items.map((r) => ({
      title: String(r.title ?? "(untitled)"),
      url: String(r.link ?? ""),
      snippet: `Score: ${r.score ?? 0} | Answered: ${r.is_answered ? "Yes" : "No"}`,
      source: "stackoverflow",
    }))
  } catch {
    return []
  }
}

const PROVIDERS: Record<string, (query: string, maxResults: number) => Promise<SearchResult[]>> = {
  hsearch: searchHsearch,
  duckduckgo: searchDuckDuckGo,
  wiby: searchWiby,
  mojeek: searchMojeek,
  bing: searchBing,
  brave: searchBrave,
  qwant: searchQwant,
  google: searchGoogle,
  ecosia: searchEcosia,
  baidu: searchBaidu,
  yandex: searchYandex,
  naver: searchNaver,
  wikipedia: searchWikipedia,
  arxiv: searchArxiv,
  github: searchGitHub,
  stackoverflow: searchStackOverflow,
}

const DEFAULT_ORDER = [
  "hsearch",
  "duckduckgo",
  "wiby",
  "bing",
  "brave",
  "qwant",
  "google",
  "mojeek",
  "ecosia",
  "baidu",
  "yandex",
  "naver",
  "wikipedia",
  "arxiv",
  "github",
  "stackoverflow",
]
const MAX_RESULTS_CAP = 10
const DEFAULT_CONTEXT_MAX_CHARS = 10000

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  const out: SearchResult[] = []
  for (const r of results) {
    const key = r.url || r.title
    if (!seen.has(key)) {
      seen.add(key)
      out.push(r)
    }
  }
  return out
}

async function multiSearch(query: string, maxResults: number, preferredProvider?: string): Promise<SearchResult[]> {
  const providers: string[] = []
  if (preferredProvider && preferredProvider !== "auto" && PROVIDERS[preferredProvider]) {
    providers.push(preferredProvider)
  }
  for (const p of DEFAULT_ORDER) {
    if (!providers.includes(p)) providers.push(p)
  }

  const allResults: SearchResult[] = []
  for (const provider of providers) {
    try {
      const results = await PROVIDERS[provider](query, Math.ceil(maxResults * 1.5))
      if (results.length > 0) {
        allResults.push(...results)
        if (allResults.length >= maxResults) break
      }
    } catch {
      /* provider failed, continue to next */
    }
  }
  return dedupeResults(allResults).slice(0, maxResults)
}

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No web results for "${query}".`
  }
  const bySource = new Map<string, SearchResult[]>()
  for (const r of results) {
    const list = bySource.get(r.source) ?? []
    list.push(r)
    bySource.set(r.source, list)
  }
  const lines: string[] = [`Found ${results.length} results from ${bySource.size} providers for "${query}":\n`]
  let idx = 1
  for (const [source, list] of bySource) {
    lines.push(`[${source.toUpperCase()}]`)
    for (const r of list) {
      // Links are real destinations (DuckDuckGo uddg redirects are resolved
      // at parse time), so the model can web_fetch/web_browse them directly.
      lines.push(`${idx}. ${r.title}\n   ${r.url}\n   ${r.snippet}\n`)
      idx++
    }
  }
  return lines.join("\n")
}

export function createWebSearchTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context) {
      const ctx = context as ToolContext
      if (signal?.aborted) return textResult("aborted", /*isError*/ true)

      const query = String(args.query ?? "")
      if (!query.trim()) return textResult("Missing 'query'.", /*isError*/ true)
      const maxResults =
        typeof args.max_results === "number"
          ? Math.max(1, Math.min(MAX_RESULTS_CAP, args.max_results))
          : MAX_RESULTS_CAP
      const provider = String(args.provider ?? "auto")
      const contextMaxChars =
        typeof args.context_max_characters === "number"
          ? Math.max(1000, args.context_max_characters)
          : DEFAULT_CONTEXT_MAX_CHARS

      // Recency guard: keep search queries current. Replace stale years with the
      // current year (unless the user explicitly pinned an older year), and append
      // the current year when the query has no year at all.
      const nowYear = new Date().getFullYear()
      const yearRe = /\b(20\d{2})\b/g
      const foundYears = [...query.matchAll(yearRe)].map((m) => Number(m[1]))
      const oldestAllowed = nowYear - 2
      let searchQuery = query
      const hasRecentYear = foundYears.some((y) => y >= oldestAllowed)
      if (foundYears.length > 0 && !hasRecentYear) {
        searchQuery = query.replace(yearRe, String(nowYear))
      } else if (foundYears.length === 0 && /latest|new|recent|update|news|current|release|version/i.test(query)) {
        searchQuery = `${query} ${nowYear}`
      }

      if (signal?.aborted) return textResult("aborted", /*isError*/ true)

      try {
        const results = await multiSearch(searchQuery, maxResults, provider)
        const out = formatResults(results, searchQuery)
        const truncated = truncateOutput(out, ctx.config)

        // Apply contextMaxChars cap for LLM-optimized output
        let finalText = truncated.text
        if (finalText.length > contextMaxChars) {
          finalText =
            finalText.slice(0, contextMaxChars) + `\n\n[truncated to ${contextMaxChars} characters for LLM context]`
        }

        return textResult(finalText)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return textResult(`web_search error: ${message}`, /*isError*/ true)
      }
    },
  }
}

export { multiSearch, type SearchResult }
