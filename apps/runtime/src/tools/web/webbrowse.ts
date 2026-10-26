/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as https from "https"
import * as http from "http"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolResult } from "../types.js"
import { guardedLookup, urlBlockReason } from "./net-guard.js"

const TRUSTED_HOSTS = new Set<string>([
  "localhost",
  "127.0.0.1",
  "[0:0:0:0:0:0:0:1]",
  "[::1]",
  "0.0.0.0",
  "[::]",
  "::1",
  "::",
])

const MAX_REDIRECTS = 5
const DEFAULT_MAX_BYTES = 20 * 1024

type PageState = {
  url: string
  status: number
  title: string
  body: string
  /** Anchors extracted from the RAW html. The stored body is sanitized
   *  (tags stripped), so follow_link must use this — deriving links from
   *  `body` never matched an `<a>` tag and made follow_link always fail
   *  with "out of range". */
  links: Array<{ text: string; href: string }>
  contentType: string
  timestamp: number
}

type BrowserSession = {
  currentUrl: string | null
  history: Array<{ url: string; status: number }>
  cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number }>
  headers: Record<string, string>
  pages: PageState[]
}

function createSession(): BrowserSession {
  return {
    currentUrl: null,
    history: [],
    cookies: [],
    headers: {
      "User-Agent": "nemo-browser/0.3 (+agent)",
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
    },
    pages: [],
  }
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<object[\s\S]*?<\/object>/gi, " ")
    .replace(/<embed[\s\S]*?<\/embed>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ")
    .replace(/<input[\s\S]*?>/gi, " ")
    .replace(/<button[\s\S]*?<\/button>/gi, " ")
    .replace(/<textarea[\s\S]*?<\/textarea>/gi, " ")
    .replace(/<select[\s\S]*?<\/select>/gi, " ")
    .replace(/<option[\s\S]*?<\/option>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x60;/gi, "'")
    .replace(/&#96;/gi, "'")
    .replace(/&#8216;/gi, "'")
    .replace(/&#8217;/gi, "'")
    .replace(/&#8220;/gi, '"')
    .replace(/&#8221;/gi, '"')
    .replace(/&#8230;/g, "...")
    .replace(/&#8211;/g, "-")
    .replace(/&#8212;/g, "--")
    .replace(/&#039;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&cent;/gi, "¢")
    .replace(/&pound;/gi, "£")
    .replace(/&yen;/gi, "¥")
    .replace(/&euro;/gi, "€")
    .replace(/&copy;/gi, "©")
    .replace(/&reg;/gi, "®")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
}

function extractLinks(html: string, base: URL): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = []
  const seen = new Set<string>()
  const re = /<a\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].replace(/^["']|["']$/g, "")
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(raw)) continue
    const inner = m[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
    let resolved: string
    try {
      resolved = new URL(raw, base).toString()
    } catch {
      continue
    }
    if (!/^https?:$/.test(new URL(resolved).protocol)) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)
    links.push({ text: inner, href: resolved })
    if (links.length >= 20) break
  }
  return links
}

function parseCookies(
  setCookieHeader: string | undefined,
): Array<{ name: string; value: string; domain: string; path: string; expires?: number }> {
  if (!setCookieHeader) return []
  const cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number }> = []
  const parts = setCookieHeader.split(";")
  if (parts.length === 0) return cookies
  const [first, ...rest] = parts
  const [nameValue] = first.trim().split("=")
  if (!nameValue) return cookies
  const eqIdx = first.indexOf("=")
  const cName = first.slice(0, eqIdx).trim()
  const cValue = first.slice(eqIdx + 1).trim()
  let cDomain = ""
  let cPath = "/"
  let cExpires: number | undefined
  for (const part of rest) {
    const trimmed = part.trim()
    if (trimmed.startsWith("Domain=")) cDomain = trimmed.slice(7).trim()
    else if (trimmed.startsWith("Path=")) cPath = trimmed.slice(5).trim()
    else if (trimmed.startsWith("Expires=")) {
      const expDate = new Date(trimmed.slice(8).trim())
      if (!Number.isNaN(expDate.getTime())) cExpires = expDate.getTime()
    }
  }
  cookies.push({ name: cName, value: cValue, domain: cDomain || "", path: cPath, expires: cExpires })
  return cookies
}

function applyCookies(
  headers: Record<string, string>,
  cookies: Array<{ name: string; value: string; domain: string; path: string }>,
  targetHost: string,
): void {
  const relevant = cookies.filter((c) => {
    if (!c.domain) return true
    return targetHost.includes(c.domain)
  })
  if (relevant.length === 0) return
  const cookieHeader = relevant.map((c) => `${c.name}=${c.value}`).join("; ")
  headers["Cookie"] = cookieHeader
}

function finishSession(
  session: BrowserSession,
  buf: string,
  status: number,
  usedUrl: string,
  contentType: string,
  withLinks: boolean,
  maxBytes: number,
  resolve: (r: ToolResult) => void,
): void {
  let base: URL
  try {
    base = new URL(usedUrl)
  } catch {
    base = new URL("https://localhost/")
  }
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
  const cleaned = isHtml ? sanitizeHtml(buf) : buf
  // Links always come from the raw html (the stored body is tag-stripped);
  // `withLinks` only gates whether they appear in the output below.
  const links = isHtml ? extractLinks(buf, base) : []
  const final = cleaned.length > maxBytes ? cleaned.slice(0, maxBytes) + `\n[truncated to ${maxBytes} bytes]` : cleaned

  session.currentUrl = usedUrl
  session.pages.push({
    url: usedUrl,
    status,
    title: extractTitle(buf),
    body: final,
    links,
    contentType,
    timestamp: Date.now(),
  })
  session.history.push({ url: usedUrl, status })

  const parts: string[] = [`HTTP ${status} GET ${usedUrl}\n\n${final}`]
  if (withLinks && links.length > 0) {
    parts.push(`\n\n[links]\n${links.map((l) => `- ${l.href}${l.text ? `  (${l.text})` : ""}`).join("\n")}`)
  } else if (withLinks && isHtml) {
    parts.push("\n\n[links] none found on this page")
  }
  resolve({ content: [{ type: "text", text: parts.join("\n") }], isError: status >= 400 })
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match) return ""
  return match[1].replace(/<[^>]+>/g, "").trim()
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "web_browse",
  description:
    "Open and read a web page like a browser: returns readable page text plus a list of clickable links (absolute URLs) so you can navigate between pages. Follows a host-trust guard — loopback/localhost is always allowed, and remote plain-HTTP pages are refused. Supports session-based navigation (open_url, go_back, go_forward, follow_link) and cookie persistence across requests.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", description: "The page URL to open." },
      with_links: { type: "boolean", description: "Include discovered links. Default true." },
      max_bytes: { type: "integer", description: "Maximum response bytes to keep. Default 20 KiB." },
      action: {
        type: "string",
        description: "Action: open (default), open_url, go_back, go_forward, follow_link, refresh. Default open.",
      },
      link_index: { type: "integer", description: "Index of the link to follow (for follow_link action, 0-based)." },
      headers: { type: "string", description: "JSON-encoded header map to set for this session." },
    },
  },
}

let session = createSession()

/** Drop cookies/history/pages and start a fresh browser session.
 *  The session is a module singleton on purpose (cookies and navigation
 *  history persist across tool rebuilds — documented tool behavior), so
 *  tests use this to guarantee an empty session regardless of run order. */
export function resetWebBrowseSession(): void {
  session = createSession()
}

export function createWebBrowseTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal): Promise<ToolResult> {
      const action = (args.action as string) ?? "open"

      if (action === "go_back") {
        if (session.history.length <= 1) {
          return textResult("No previous pages in history.", /*isError*/ true)
        }
        session.history.pop()
        const prev = session.history[session.history.length - 1]
        return executeNavigate(
          prev.url,
          typeof args.with_links === "boolean" ? args.with_links : true,
          typeof args.max_bytes === "number" ? args.max_bytes : DEFAULT_MAX_BYTES,
          signal,
        )
      }

      if (action === "go_forward") {
        return textResult(
          "Forward navigation requires re-requesting the URL. Use open_url with the desired URL.",
          /*isError*/ true,
        )
      }

      if (action === "refresh") {
        if (!session.currentUrl) return textResult("No page to refresh.", /*isError*/ true)
        return executeNavigate(
          session.currentUrl,
          typeof args.with_links === "boolean" ? args.with_links : true,
          typeof args.max_bytes === "number" ? args.max_bytes : DEFAULT_MAX_BYTES,
          signal,
        )
      }

      if (action === "follow_link") {
        if (!session.currentUrl) return textResult("No current page to follow links from.", /*isError*/ true)
        const idx = typeof args.link_index === "number" ? args.link_index : 0
        const currentPage = session.pages[session.pages.length - 1]
        // Anchors were captured from the raw html when the page was stored;
        // re-parsing the sanitized body would find no <a> tags at all.
        const links = currentPage ? currentPage.links : []
        if (idx < 0 || idx >= links.length)
          return textResult(`Link index ${idx} out of range (0-${links.length - 1}).`, /*isError*/ true)
        return executeNavigate(
          links[idx].href,
          /*withLinks*/ true,
          typeof args.max_bytes === "number" ? args.max_bytes : DEFAULT_MAX_BYTES,
          signal,
        )
      }

      if (action === "open_url") {
        const targetUrl = typeof args.url === "string" ? args.url : ""
        if (!targetUrl) return textResult("Missing 'url' parameter for open_url.", /*isError*/ true)
        if (typeof args.headers === "string") {
          try {
            const extraHeaders = JSON.parse(args.headers) as Record<string, string>
            Object.assign(session.headers, extraHeaders)
          } catch {
            /* ignore malformed headers */
          }
        }
        return executeNavigate(
          targetUrl,
          /*withLinks*/ true,
          typeof args.max_bytes === "number" ? args.max_bytes : DEFAULT_MAX_BYTES,
          signal,
        )
      }

      const target = String(args.url ?? "")
      if (!target) return textResult("Missing 'url'.", /*isError*/ true)
      const withLinks = args.with_links !== false
      const maxBytes = typeof args.max_bytes === "number" ? args.max_bytes : DEFAULT_MAX_BYTES
      if (typeof args.headers === "string") {
        try {
          const extraHeaders = JSON.parse(args.headers) as Record<string, string>
          Object.assign(session.headers, extraHeaders)
        } catch {
          /* ignore malformed headers */
        }
      }
      return executeNavigate(target, withLinks, maxBytes, signal)
    },
  }
}

function executeNavigate(
  target: string,
  withLinks: boolean,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return Promise.resolve(textResult(`Invalid URL: ${target}`, /*isError*/ true))
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return Promise.resolve(
      textResult(`web_browse only supports http/https URLs (got "${parsed.protocol}").`, /*isError*/ true),
    )
  }
  // Link-local / cloud-metadata refusal before any socket (#73) — applies
  // to https hops too, which the plain-HTTP policy below never covers.
  const block = urlBlockReason(parsed)
  if (block) return Promise.resolve(textResult(`Blocked URL: ${block}`, /*isError*/ true))

  const trusted = TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())
  const insecureRemote = parsed.protocol === "http:" && !trusted
  if (insecureRemote) {
    return Promise.resolve(
      textResult(
        `Refusing to load plain-HTTP URL to untrusted host "${parsed.hostname}". Use https:// for remote pages, or an explicit loopback address for local services (http://localhost/...).`,
        /*isError*/ true,
      ),
    )
  }

  return new Promise<ToolResult>((resolve) => {
    navigateWithRedirect(parsed, withLinks, maxBytes, signal, resolve)
  })
}

function navigateWithRedirect(
  parsed: URL,
  withLinks: boolean,
  maxBytes: number,
  signal: AbortSignal | undefined,
  resolve: (r: ToolResult) => void,
  redirectCount: number = 0,
): void {
  const lib = parsed.protocol === "https:" ? https : http
  const headers = { ...session.headers }
  applyCookies(headers, session.cookies, parsed.hostname)

  const req = lib.request(
    {
      method: "GET",
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers,
      timeout: 20_000,
      // DNS-rebinding guard: refuse resolutions into link-local space (#73).
      lookup: guardedLookup,
    },
    (res) => {
      const status = res.statusCode ?? 0
      const contentType = String(res.headers["content-type"] ?? "").toLowerCase()

      if (res.headers["set-cookie"]) {
        const cookieHeaders = Array.isArray(res.headers["set-cookie"])
          ? (res.headers["set-cookie"] as string[])
          : [res.headers["set-cookie"] as string]
        for (const cookieHeader of cookieHeaders) {
          const cookies = parseCookies(cookieHeader)
          session.cookies.push(...cookies)
        }
      }

      const location = res.headers["location"]
      if (
        location &&
        (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
        redirectCount < MAX_REDIRECTS
      ) {
        let redirectUrl: string
        try {
          redirectUrl = new URL(location, parsed.toString()).toString()
        } catch {
          redirectUrl = location
        }
        // A malformed location must not throw inside the response callback
        // (an uncaught throw here takes the whole process down).
        let redirectParsed: URL
        try {
          redirectParsed = new URL(redirectUrl)
        } catch {
          resolve({
            content: [{ type: "text", text: `Invalid redirect location: ${location}` }],
            isError: true,
          })
          return
        }
        // Every hop re-runs the URL policy (#73): link-local targets are
        // refused, and the plain-HTTP trusted-host rule from the initial
        // load applies here too — an https page must not 302 into plain
        // http on an untrusted host.
        const hopBlock = urlBlockReason(redirectParsed)
        if (hopBlock) {
          resolve({ content: [{ type: "text", text: `Redirect blocked: ${hopBlock}` }], isError: true })
          return
        }
        if (redirectParsed.protocol === "http:" && !TRUSTED_HOSTS.has(redirectParsed.hostname.toLowerCase())) {
          resolve({
            content: [
              {
                type: "text",
                text: `Refusing redirect to plain-HTTP URL to untrusted host "${redirectParsed.hostname}".`,
              },
            ],
            isError: true,
          })
          return
        }
        navigateWithRedirect(redirectParsed, withLinks, maxBytes, signal, resolve, redirectCount + 1)
        return
      }

      let buf = ""
      res.setEncoding("utf8")
      res.on("data", (cd) => {
        if (buf.length < maxBytes) buf += cd
      })
      res.on("end", () =>
        finishSession(
          session,
          buf,
          status,
          targetResolve(parsed, location, redirectCount),
          contentType,
          withLinks,
          maxBytes,
          resolve,
        ),
      )
      res.on("error", (err) =>
        resolve({ content: [{ type: "text", text: `Response error: ${err.message}` }], isError: true }),
      )
    },
  )
  req.on("error", (err) =>
    resolve({ content: [{ type: "text", text: `Request failed: ${err.message}` }], isError: true }),
  )
  if (signal) signal.addEventListener("abort", () => req.destroy())
  req.end()
}

function targetResolve(parsed: URL, location: string | undefined, redirectCount: number): string {
  if (location && redirectCount > 0) {
    try {
      return new URL(location, parsed.toString()).toString()
    } catch {
      return parsed.toString()
    }
  }
  return parsed.toString()
}
