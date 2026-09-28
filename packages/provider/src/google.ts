/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as http from "http"
import * as https from "https"
import * as url from "url"
import type { AssistantMessage, AssistantContentPart, StopReason, ToolDefinition } from "../../protocol/src/index.js"
import type { ChatInput, Provider, ProviderOptions, WireMessage } from "./types.js"

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })

function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? ""
  return code === "ECONNRESET" || code === "EPIPE" || /socket hang up|ECONNRESET|EPIPE|connection closed/i.test(msg)
}

function parseArgs(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object") return v as Record<string, unknown>
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return { __raw: v }
    }
  }
  return {}
}

/**
 * Native Google Gemini client (https://generativelanguage.googleapis.com/v1beta).
 * Uses :generateContent (non-streaming) + emits the full text via callbacks
 * once — satisfies the Provider.chat contract without SSE framing.
 * Auth via ?key= API key query param.
 */
export class GoogleProvider implements Provider {
  readonly id = "google"
  protected apiErrorPrefix = "Google API"

  constructor(protected readonly options: ProviderOptions) {
    const normalized = options.baseUrl.replace(/\/+$/, "")
    this.options = {
      ...options,
      baseUrl: normalized.length > 0 ? normalized : "https://generativelanguage.googleapis.com/v1beta",
      model: options.model && options.model.length > 0 ? options.model : "gemini-2.5-flash",
    }
  }

  async chat(input: ChatInput): Promise<AssistantMessage> {
    const body = this.buildBody(input)
    return this.postGenerate(body, input.signal, input.callbacks, /*retried*/ false)
  }

  protected buildBody(input: ChatInput): Record<string, unknown> {
    const contents: Record<string, unknown>[] = []
    for (const m of input.messages) {
      if (m.role === "system") continue
      if (m.role === "user") {
        if ((m.content ?? "").trim().length === 0) continue
        contents.push({ role: "user", parts: [{ text: m.content }] })
        continue
      }
      if (m.role === "assistant") {
        const parts: Record<string, unknown>[] = []
        if (m.content && m.content.trim().length > 0) parts.push({ text: m.content })
        for (const tc of m.tool_calls ?? []) {
          parts.push({ functionCall: { name: tc.function.name, args: parseArgs(tc.function.arguments) } })
        }
        if (parts.length === 0) continue
        contents.push({ role: "model", parts })
        continue
      }
      if (m.role === "tool") {
        contents.push({
          role: "user",
          parts: [{ functionResponse: { name: m.name ?? "tool", response: { result: m.content ?? "" } } }],
        })
        continue
      }
      contents.push({ role: "user", parts: [{ text: m.content ?? "" }] })
    }
    const body: Record<string, unknown> = { contents }
    const systemText = [input.system, ...input.messages.filter((m) => m.role === "system").map((m) => m.content ?? "")]
      .filter(Boolean)
      .join("\n")
    if (systemText.trim().length > 0) {
      body.system_instruction = { parts: [{ text: systemText }] }
    }
    if (input.tools && input.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters ?? { type: "object" },
          })),
        },
      ]
    }
    const gen: Record<string, unknown> = {}
    if (this.options.temperature !== undefined) gen.temperature = this.options.temperature
    if (this.options.topP !== undefined) gen.topP = this.options.topP
    if (this.options.maxTokens !== undefined) gen.maxOutputTokens = this.options.maxTokens
    if (Object.keys(gen).length > 0) body.generationConfig = gen
    return body
  }

  protected postGenerate(
    payload: unknown,
    signal: AbortSignal | undefined,
    callbacks: ChatInput["callbacks"],
    retried: boolean,
  ): Promise<AssistantMessage> {
    const base = new url.URL(this.options.baseUrl.replace(/\/+$/, ""))
    const isHttps = base.protocol === "https:"
    const lib = isHttps ? https : http
    const data = JSON.stringify(payload)
    const key = this.options.apiKey ?? ""
    const modelPath = `/models/${encodeURIComponent(this.options.model)}:generateContent`
    const query = key ? `?key=${encodeURIComponent(key)}` : ""
    return new Promise<AssistantMessage>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true
          clearTimeout(firstByteTimer)
          fn()
        }
      }
      const options: http.RequestOptions = {
        method: "POST",
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path: (base.pathname && base.pathname !== "/" ? base.pathname.replace(/\/$/, "") : "") + modelPath + query,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Connection: "keep-alive",
        },
        timeout: this.options.timeoutMs ?? 600_000,
        agent: isHttps ? httpsAgent : httpAgent,
      }
      let receivedData = false
      const req = lib.request(options, (res) => {
        clearTimeout(firstByteTimer)
        const status = res.statusCode ?? 0
        let buf = ""
        res.setEncoding("utf8")
        res.on("data", (c) => {
          receivedData = true
          buf += c
        })
        res.on("end", () => {
          if (status >= 400) {
            settle(() => reject(new Error(`${this.apiErrorPrefix} returned ${status}: ${buf.slice(0, 500)}`)))
            return
          }
          try {
            const msg = this.parseResponse(buf, callbacks)
            settle(() => resolve(msg))
          } catch (err) {
            settle(() => reject(err instanceof Error ? err : new Error(String(err))))
          }
        })
        res.on("error", (err) => settle(() => reject(err)))
      })
      const firstByteTimer = setTimeout(() => {
        if (settled) return
        req.destroy()
        settle(() =>
          reject(
            new Error(
              `Provider did not respond within 60s (POST ${base.host}${modelPath}) — check the provider/endpoint, or Ctrl+D to abort`,
            ),
          ),
        )
      }, 60_000)
      req.on("timeout", () => {
        req.destroy()
        settle(() => reject(new Error("Request timed out")))
      })
      req.on("error", (err) => {
        if (!receivedData && !retried && !signal?.aborted && isTransientNetworkError(err)) {
          setTimeout(() => {
            this.postGenerate(payload, signal, callbacks, /*retried*/ true).then(resolve, reject)
          }, 250)
          return
        }
        settle(() => reject(err))
      })
      if (signal) {
        if (signal.aborted) {
          req.destroy()
          settle(() => reject(new Error("aborted")))
          return
        }
        signal.addEventListener(
          "abort",
          () => {
            req.destroy()
            settle(() => reject(new Error("aborted")))
          },
          { once: true },
        )
      }
      req.end(data)
    })
  }

  protected parseResponse(raw: string, callbacks: ChatInput["callbacks"]): AssistantMessage {
    const json = JSON.parse(raw) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> }
        finishReason?: string
      }>
      promptFeedback?: { blockReason?: string }
    }
    const cand = json.candidates?.[0]
    if (!cand) {
      const blocked = json.promptFeedback?.blockReason
      throw new Error(blocked ? `Google API blocked the prompt: ${blocked}` : "Google API returned no candidates")
    }
    const parts: AssistantContentPart[] = []
    let text = ""
    const toolCalls: AssistantContentPart[] = []
    for (const p of cand.content?.parts ?? []) {
      if (typeof p.text === "string" && p.text.length > 0) text += p.text
      if (p.functionCall) {
        toolCalls.push({
          type: "toolCall",
          id: `call_${toolCalls.length}`,
          name: p.functionCall.name ?? "",
          arguments: parseArgs(p.functionCall.args),
        })
      }
    }
    if (text.length > 0) {
      parts.push({ type: "text", text })
      callbacks?.onText?.(text)
      for (const tc of toolCalls) {
        if (tc.type === "toolCall") callbacks?.onToolCallDelta?.(tc.name, JSON.stringify(tc.arguments))
      }
    } else if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        if (tc.type === "toolCall") callbacks?.onToolCallDelta?.(tc.name, JSON.stringify(tc.arguments))
      }
    }
    parts.push(...(toolCalls as AssistantContentPart[]))
    let stop: StopReason = "end_turn"
    const fr = (cand.finishReason ?? "").toUpperCase()
    if (toolCalls.length > 0) stop = "tool_use"
    else if (fr === "MAX_TOKENS") stop = "length"
    else if (fr === "SAFETY" || fr === "BLOCKED" || fr === "PROHIBITED_CONTENT") stop = "error"
    return { role: "assistant", content: parts, stopReason: stop }
  }
}

export function createGoogleProvider(options: ProviderOptions): Provider {
  return new GoogleProvider(options)
}

/** Wire-format helper: convert OpenAI-style messages to Gemini body (unit-tested). */
export function toGeminiBody(
  input: { system?: string; messages: WireMessage[]; tools?: ToolDefinition[] },
  model: string,
): Record<string, unknown> {
  const p = new GoogleProvider({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", model })
  return p["buildBody"]({ messages: input.messages, system: input.system, tools: input.tools })
}
