/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as https from "https"
import * as http from "http"
import * as url from "url"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolResult } from "../types.js"
import { guardedLookup, urlBlockReason } from "./net-guard.js"
import { decodeEntities as decodeHtmlEntities, htmlToText, stripRegions, stripTags } from "./html-text.js"

type CacheEntry = { status: number; body: string; headers: Record<string, string>; timestamp: number }

const CACHE = new Map<string, CacheEntry>()
const DEFAULT_CACHE_TTL_MS = 60_000
const DEFAULT_MAX_BYTES = 20 * 1024
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT = 15_000
const MAX_REDIRECTS = 5

function sanitizeHtml(html: string): string {
  return htmlToText(html)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "web_fetch",
  description:
    "Fetch a URL over HTTP(S) and return its body as text. Truncates long responses. Uses a small in-memory cache (60s TTL by default). Set method=POST and body=... for write operations. Cache is skipped for non-GET requests. Supports format=markdown for HTML-to-markdown conversion, with automatic Cloudflare bypass retry.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", description: "The URL to fetch." },
      method: { type: "string", description: "HTTP method. Default GET." },
      body: { type: "string", description: "Optional request body." },
      headers: { type: "string", description: "Optional JSON-encoded header map." },
      max_bytes: { type: "integer", description: "Maximum response bytes to keep. Default 20 KiB, max 5 MB." },
      cache_ttl_ms: {
        type: "integer",
        description: "Cache TTL in milliseconds. Default 60000. Set 0 to bypass cache.",
      },
      format: {
        type: "string",
        description: "Output format: 'text', 'markdown', or 'html' (default markdown).",
        enum: ["text", "markdown", "html"],
      },
      timeout: { type: "integer", description: "Request timeout in seconds (max 120). Default 15." },
    },
  },
}

function buildCacheKey(
  target: string,
  method: string,
  body: string | undefined,
  format: string,
  headers: Record<string, string>,
  maxBytes: number,
): string {
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k.toLowerCase()}:${headers[k]}`)
    .join("|")
  return `${method}:${format}:${maxBytes}:${canonicalHeaders}:${target}:${body ?? ""}`
}

export function createWebFetchTool(): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, _context) {
      if (signal?.aborted) return textResult("aborted", /*isError*/ true)

      const target = String(args.url ?? "")
      if (!target) return textResult("Missing 'url'.", /*isError*/ true)
      let parsed: URL
      try {
        parsed = new url.URL(target)
      } catch {
        return textResult(`Invalid URL: ${target}`, /*isError*/ true)
      }
      if (!parsed.protocol.startsWith("http")) {
        return textResult(`URL must start with http:// or https://`, /*isError*/ true)
      }
      // Link-local / cloud-metadata refusal before any socket (#73); also
      // catches schemes like `httpfoo:` that pass the startsWith check.
      const block = urlBlockReason(parsed)
      if (block) return textResult(`Blocked URL: ${block}`, /*isError*/ true)

      const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET"
      const maxBytes = Math.min(
        typeof args.max_bytes === "number" ? args.max_bytes : DEFAULT_MAX_BYTES,
        MAX_RESPONSE_SIZE,
      )
      const cacheTtl = typeof args.cache_ttl_ms === "number" ? args.cache_ttl_ms : DEFAULT_CACHE_TTL_MS
      const body = typeof args.body === "string" ? args.body : undefined
      const format = (typeof args.format === "string" ? args.format : "markdown") as "text" | "markdown" | "html"
      const timeoutSec =
        typeof args.timeout === "number" ? Math.max(1, Math.min(120, args.timeout)) : Math.floor(DEFAULT_TIMEOUT / 1000)
      const timeoutMs = timeoutSec * 1000

      const extraHeaders: Record<string, string> = (() => {
        if (typeof args.headers !== "string") return {}
        try {
          return JSON.parse(args.headers) as Record<string, string>
        } catch {
          return {}
        }
      })()

      const cacheKey = buildCacheKey(target, method, body, format, extraHeaders, maxBytes)
      if (method === "GET" && cacheTtl > 0) {
        const cached = CACHE.get(cacheKey)
        if (cached && Date.now() - cached.timestamp < cacheTtl) {
          const final =
            cached.body.length > maxBytes
              ? cached.body.slice(0, maxBytes) + `\n[truncated to ${maxBytes} bytes]`
              : cached.body
          return textResult(`HTTP ${cached.status} ${method} ${target} (cached)\n\n${final}`, cached.status >= 400)
        }
      }

      if (signal?.aborted) return textResult("aborted", /*isError*/ true)

      return new Promise<ToolResult>((resolve) => {
        let aborted = false
        const onAbort = () => {
          aborted = true
          fetchWithRedirect(parsed, method, body, extraHeaders, 0, maxBytes, timeoutMs, signal, () => {
            if (aborted) resolve(textResult("aborted", /*isError*/ true))
          })
        }

        if (signal?.aborted) {
          resolve(textResult("aborted", /*isError*/ true))
          return
        }

        signal?.addEventListener("abort", onAbort, { once: true })

        fetchWithRedirect(
          parsed,
          method,
          body,
          extraHeaders,
          0,
          maxBytes,
          timeoutMs,
          signal,
          (err, resBody, resStatus, resHeaders, finalUrl) => {
            signal?.removeEventListener("abort", onAbort)
            if (aborted) {
              resolve(textResult("aborted", /*isError*/ true))
              return
            }
            if (err) {
              resolve(textResult(`Request failed: ${err.message}`, /*isError*/ true))
              return
            }
            if (signal?.aborted) {
              resolve(textResult("aborted", /*isError*/ true))
              return
            }

            const usedUrl = finalUrl ?? target
            const contentType = String(resHeaders["content-type"] ?? "").toLowerCase()
            const isImage = contentType.startsWith("image/")
            const statusNum = resStatus ?? 0

            // Handle image attachments as inline base64 content
            if (isImage && resBody.length > 0) {
              const base64Content = Buffer.from(resBody, "binary").toString("base64")
              resolve({
                content: [
                  {
                    type: "text",
                    text: `HTTP ${statusNum} ${method} ${usedUrl}\n\nImage fetched successfully (${base64Content.length} base64 chars, mime: ${contentType})`,
                  },
                  { type: "text", text: `data:${contentType};base64,${base64Content}` },
                ],
                isError: statusNum >= 400,
              })
              return
            }

            const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
            let final: string
            if (format === "html" && isHtml) {
              final = resBody
            } else if (format === "markdown" && isHtml) {
              final = sanitizeHtmlToMarkdown(resBody)
            } else if (isHtml) {
              final = sanitizeHtml(resBody)
            } else {
              final = resBody
            }

            if (final.length > maxBytes) final = final.slice(0, maxBytes) + `\n[truncated to ${maxBytes} bytes]`
            const status = resStatus ?? 0

            if (method === "GET" && cacheTtl > 0 && status >= 200 && status < 300) {
              CACHE.set(cacheKey, { status, body: final, headers: resHeaders, timestamp: Date.now() })
            }

            resolve(textResult(`HTTP ${status} ${method} ${usedUrl}\n\n${final}`, status >= 400))
          },
        )
      })
    },
  }
}

/** Convert HTML to markdown-friendly text (simplified turndown). */
export function sanitizeHtmlToMarkdown(html: string): string {
  let text = stripRegions(html)
  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
  text = text.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n")
  text = text.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n")
  text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "```\n$1\n```\n\n")
  text = text.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
  text = text.replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n")
  text = text.replace(/<br\s*\/?>/gi, "\n")
  text = stripTags(text)
  text = decodeHtmlEntities(text)
  text = text.replace(/[ \t]+/g, " ")
  text = text.replace(/\n{3,}/g, "\n\n")
  return text.trim()
}

function fetchWithRedirect(
  parsed: URL,
  method: string,
  body: string | undefined,
  extraHeaders: Record<string, string>,
  redirectCount: number,
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  callback: (
    err: Error | null,
    body: string,
    status: number | null,
    headers: Record<string, string>,
    finalUrl: string | null,
  ) => void,
): void {
  if (signal?.aborted) {
    callback(new Error("aborted"), "", null, {}, null)
    return
  }

  const lib = parsed.protocol === "https:" ? https : http
  const req = lib.request(
    {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": "nemo/0.2 (+local)",
        Accept: "text/plain,text/html,application/json;q=0.9,*/*;q=0.5",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        ...extraHeaders,
      },
      timeout: timeoutMs,
      // DNS-rebinding guard: refuse resolutions into link-local space (#73).
      lookup: guardedLookup,
    },
    (res) => {
      const status = res.statusCode ?? 0
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
          redirectUrl = String(location)
        }
        // A malformed location must not throw inside the response callback
        // (an uncaught throw here takes the whole process down — same guard
        // web_browse already had; #74), and every hop re-runs the URL policy
        // so a redirect can't pivot into link-local space (#73).
        let redirectParsed: URL
        try {
          redirectParsed = new URL(redirectUrl)
        } catch {
          callback(new Error(`Invalid redirect location: ${String(location)}`), "", null, {}, null)
          return
        }
        const hopBlock = urlBlockReason(redirectParsed)
        if (hopBlock) {
          callback(new Error(`Redirect blocked: ${hopBlock}`), "", null, {}, null)
          return
        }
        // HTTP redirect semantics: 307/308 repeat the exact method with the
        // ORIGINAL body; 301/302/303 downgrade POST to GET (303 forces GET;
        // HEAD stays HEAD) and drop the body. The redirect RESPONSE body is
        // just drained — it must never become the next request's payload,
        // and the original body must survive 307/308 intact.
        const hopMethod = status === 307 || status === 308 ? method : method === "HEAD" ? "HEAD" : "GET"
        const hopBody = status === 307 || status === 308 ? body : undefined
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          void chunks
          fetchWithRedirect(
            redirectParsed,
            hopMethod,
            hopBody,
            extraHeaders,
            redirectCount + 1,
            maxBytes,
            timeoutMs,
            signal,
            callback,
          )
        })
        res.on("error", (err) => callback(err, "", null, {}, null))
        return
      }

      // Shrijan feature: Cloudflare bypass - retry with "" User-Agent on 403 challenge
      const cfMitigated = res.headers["cf-mitigated"]
      const cfChallenge =
        res.headers["content-type"]?.toLowerCase().includes("text/html") &&
        (res.statusCode === 403 || res.statusCode === 429)

      const contentType = String(res.headers["content-type"] ?? "").toLowerCase()
      const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
      const chunks: Buffer[] = []

      // Enforce content-length pre-check
      const contentLength = res.headers["content-length"]
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        res.destroy()
        callback(new Error("Response too large (exceeds 5MB limit)"), "", null, {}, null)
        return
      }

      res.on("data", (c) => {
        chunks.push(c)
        if (Buffer.concat(chunks).length > MAX_RESPONSE_SIZE) {
          res.destroy()
          callback(new Error("Response too large (exceeds 5MB limit)"), "", null, {}, null)
        }
      })
      res.on("end", () => {
        const buf = Buffer.concat(chunks)
        if (buf.length > MAX_RESPONSE_SIZE) {
          callback(new Error("Response too large (exceeds 5MB limit)"), "", null, {}, null)
          return
        }

        // Cloudflare bypass retry: a DIFFERENT User-Agent from the primary
        // request (the custom one got challenged; the retry varies the signal).
        if (cfChallenge && cfMitigated === "challenge" && redirectCount === 0) {
          const retryHeaders = { ...extraHeaders, "User-Agent": "nemo" }
          fetchWithRedirect(parsed, method, body, retryHeaders, 0, maxBytes, timeoutMs, signal, callback)
          return
        }

        // The raw body is passed up; format handling (html/text/markdown)
        // happens in execute so `format=html` can genuinely keep the HTML.
        const resHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") resHeaders[k] = v
          else if (Array.isArray(v)) resHeaders[k] = v.join(",")
        }
        callback(null, buf.toString("utf8"), status, resHeaders, parsed.toString())
      })
      res.on("error", (err) => callback(err, "", null, {}, null))
    },
  )
  req.on("error", (err) => callback(err, "", null, {}, null))
  req.on("timeout", () => {
    req.destroy()
    callback(new Error(`Request timed out after ${timeoutMs / 1000}s`), "", null, {}, null)
  })
  if (signal?.aborted) {
    req.destroy()
    callback(new Error("aborted"), "", null, {}, null)
  }
  signal?.addEventListener(
    "abort",
    () => {
      req.destroy()
      callback(new Error("aborted"), "", null, {}, null)
    },
    { once: true },
  )
  if (body) req.write(body)
  req.end()
}
