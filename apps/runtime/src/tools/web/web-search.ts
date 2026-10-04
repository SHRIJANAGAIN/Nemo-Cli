/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as https from "https"
import * as http from "http"
import * as url from "url"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool } from "../types.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "web_search",
  description:
    "Search the web using the enhanced hsearch service. Returns ranked results with URLs, titles, snippets, and relevance scores. Use this BEFORE answering factual questions to ensure accuracy.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: { type: "integer", description: "Max results to return. Default 10." },
      endpoint: {
        type: "string",
        description: "search, browse, or timeline. Default search.",
        enum: ["search", "browse", "timeline"],
      },
    },
  },
}

/** Hard cap on the service response: a hostile or broken hsearch endpoint
 *  streaming gigabytes must not be buffered in full (#117). */
const MAX_RESPONSE_BYTES = 2_000_000

/** Endpoints are model-supplied and land verbatim in the request path. Allow
 *  only path/query characters and reject traversal segments so a value like
 *  "../admin" cannot escape the service's endpoint namespace (#117). */
const SAFE_ENDPOINT = /^[A-Za-z0-9\-._~/?=&%+!$'()*,;:@]*$/

function isSafeEndpoint(endpoint: string): boolean {
  if (endpoint.length === 0 || endpoint.length > 200) return false
  return SAFE_ENDPOINT.test(endpoint) && !endpoint.includes("..")
}

export function createWebSearchTool(): Tool {
  const baseUrl = (process.env.HSEARCH_BASE_URL ?? "http://localhost:8000").replace(/\/+$/, "")

  const call = (endpoint: string, body: Record<string, unknown>): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const parsed = new url.URL(baseUrl)
      const lib = parsed.protocol === "https:" ? https : http
      const data = JSON.stringify(body)
      const req = lib.request(
        {
          method: "POST",
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: `/${endpoint}`,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
            Accept: "application/json",
          },
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          let settled = false
          res.on("data", (c) => {
            if (settled) return
            size += c.length
            if (size > MAX_RESPONSE_BYTES) {
              settled = true
              try {
                req.destroy()
              } catch {
                /* transport may not implement destroy (mocks) */
              }
              reject(new Error(`Response too large: exceeded ${MAX_RESPONSE_BYTES} bytes`))
              return
            }
            chunks.push(c)
          })
          res.on("end", () => {
            if (settled) return
            resolve(Buffer.concat(chunks).toString("utf8"))
          })
          res.on("error", (err) => {
            if (settled) return
            settled = true
            reject(new Error(`Response error: ${err.message}`))
          })
        },
      )
      req.on("error", (err) => reject(new Error(`Request failed: ${err.message}`)))
      req.write(data)
      req.end()
    })
  }

  return {
    definition,
    async execute(_id, args, _signal) {
      const query = String(args.query ?? "")
      if (!query) return textResult("Missing 'query'.", /*isError*/ true)
      const endpoint = String(args.endpoint ?? "search")
      if (!isSafeEndpoint(endpoint))
        return textResult(`Invalid 'endpoint': path characters only, no ".." traversal.`, /*isError*/ true)
      const maxResults = typeof args.max_results === "number" ? args.max_results : 10

      try {
        const raw = await call(endpoint, { query, max_results: maxResults })
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return textResult(`Search service returned non-JSON:\n${raw.slice(0, 2000)}`, /*isError*/ true)
        }
        const out = formatResults(endpoint, parsed as Record<string, unknown>, query)
        return textResult(out, /*isError*/ false)
      } catch (err) {
        return textResult(`web_search error: ${err instanceof Error ? err.message : String(err)}`, /*isError*/ true)
      }
    },
  }
}

function formatResults(endpoint: string, data: Record<string, unknown>, query: string): string {
  if (endpoint === "search") {
    const results = (data.results ?? data.data ?? []) as Array<Record<string, unknown>>
    if (!Array.isArray(results) || results.length === 0) {
      return `No web results for "${query}".`
    }
    const lines: string[] = [`Top ${results.length} results for "${query}":\n`]
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const title = String(r.title ?? r.name ?? "(untitled)")
      const href = String(r.url ?? r.link ?? "")
      const snippet = String(r.snippet ?? r.description ?? r.content ?? "").slice(0, 220)
      const score = typeof r.score === "number" ? ` [${r.score.toFixed(3)}]` : ""
      lines.push(`${i + 1}. ${title}${score}\n   ${href}\n   ${snippet}\n`)
    }
    return lines.join("\n")
  }
  if (endpoint === "browse") {
    const pages = (data.pages ?? data.data ?? []) as Array<Record<string, unknown>>
    if (!Array.isArray(pages) || pages.length === 0) {
      return `No browsed pages for "${query}".`
    }
    const lines: string[] = [`Browsed ${pages.length} pages for "${query}":\n`]
    for (const p of pages.slice(0, 8)) {
      const title = String(p.title ?? "(untitled)")
      const href = String(p.url ?? "")
      const text = String(p.text ?? p.content ?? "").slice(0, 600)
      lines.push(`- ${title}\n  ${href}\n  ${text}\n`)
    }
    return lines.join("\n")
  }
  if (endpoint === "timeline") {
    const events = (data.events ?? data.data ?? []) as Array<Record<string, unknown>>
    if (!Array.isArray(events) || events.length === 0) {
      return `No timeline events for "${query}".`
    }
    const lines: string[] = [`Timeline for "${query}":\n`]
    for (const e of events.slice(0, 12)) {
      const date = String(e.date ?? e.time ?? "?")
      const title = String(e.title ?? e.name ?? "")
      const snippet = String(e.snippet ?? e.description ?? "").slice(0, 200)
      lines.push(`[${date}] ${title} — ${snippet}`)
    }
    return lines.join("\n")
  }
  return JSON.stringify(data, null, 2).slice(0, 4000)
}
