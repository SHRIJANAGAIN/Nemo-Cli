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

interface AnthropicTool {
  name: string
  description: string
  input_schema: unknown
}

function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: "object" },
  }))
}

function parseArgs(raw: string): Record<string, unknown> {
  const t = raw.trim()
  if (!t) return {}
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    return { __raw: t }
  }
}

/**
 * Native Anthropic Messages client (https://api.anthropic.com/v1/messages).
 * SSE events: message_start / content_block_start|delta|stop / message_delta /
 * message_stop. Auth via x-api-key + anthropic-version header.
 */
export class AnthropicProvider implements Provider {
  readonly id = "anthropic"
  protected apiErrorPrefix = "Anthropic API"

  constructor(protected readonly options: ProviderOptions) {
    const normalized = options.baseUrl.replace(/\/+$/, "")
    this.options = {
      ...options,
      baseUrl: normalized.length > 0 ? normalized : "https://api.anthropic.com",
      model: options.model && options.model.length > 0 ? options.model : "claude-3-5-sonnet-latest",
    }
  }

  async chat(input: ChatInput): Promise<AssistantMessage> {
    const body = this.buildBody(input)
    return this.postMessages(body, input.signal, input.callbacks, /*retried*/ false)
  }

  protected buildBody(input: ChatInput): Record<string, unknown> {
    let system = input.system ?? ""
    const messages: Record<string, unknown>[] = []
    for (const m of input.messages) {
      if (m.role === "system") {
        system += (system ? "\n" : "") + (m.content ?? "")
        continue
      }
      if (m.role === "user") {
        if ((m.content ?? "").trim().length === 0) continue
        messages.push({ role: "user", content: m.content })
        continue
      }
      if (m.role === "assistant") {
        const blocks: Record<string, unknown>[] = []
        if (m.content && m.content.trim().length > 0) {
          blocks.push({ type: "text", text: m.content })
        }
        for (const tc of m.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parseArgs(tc.function.arguments),
          })
        }
        if (blocks.length === 0) continue
        messages.push({ role: "assistant", content: blocks })
        continue
      }
      if (m.role === "tool") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content ?? "",
            },
          ],
        })
        continue
      }
      messages.push({ role: "user", content: m.content ?? "" })
    }
    const body: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: this.options.maxTokens ?? 4096,
      stream: true,
      messages,
    }
    if (system.trim().length > 0) body.system = system
    if (this.options.temperature !== undefined) body.temperature = this.options.temperature
    if (this.options.topP !== undefined) body.top_p = this.options.topP
    if (input.tools && input.tools.length > 0) body.tools = toAnthropicTools(input.tools)
    return body
  }

  protected postMessages(
    payload: unknown,
    signal: AbortSignal | undefined,
    callbacks: ChatInput["callbacks"],
    retried: boolean,
  ): Promise<AssistantMessage> {
    const base = new url.URL(this.options.baseUrl.replace(/\/+$/, ""))
    const isHttps = base.protocol === "https:"
    const lib = isHttps ? https : http
    const data = JSON.stringify(payload)
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
        path: (base.pathname && base.pathname !== "/" ? base.pathname.replace(/\/$/, "") : "") + "/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Accept: "text/event-stream",
          Connection: "keep-alive",
          "anthropic-version": "2023-06-01",
        },
        timeout: this.options.timeoutMs ?? 600_000,
        agent: isHttps ? httpsAgent : httpAgent,
      }
      if (this.options.apiKey) {
        ;(options.headers as Record<string, string>)["x-api-key"] = this.options.apiKey
      }
      let receivedData = false
      const req = lib.request(options, (res) => {
        clearTimeout(firstByteTimer)
        const status = res.statusCode ?? 0
        if (status >= 400) {
          let buf = ""
          res.on("data", (c) => {
            receivedData = true
            buf += c
          })
          res.on("end", () => {
            settle(() => reject(new Error(`${this.apiErrorPrefix} returned ${status}: ${buf.slice(0, 500)}`)))
          })
          res.on("error", (err) =>
            settle(() => reject(new Error(`${this.apiErrorPrefix} returned ${status}: ${err.message}`))),
          )
          return
        }
        const text: string[] = []
        const thinking: string[] = []
        const toolBuffer = new Map<number, { id: string; name: string; args: string }>()
        const toolIndexByBlock = new Map<number, number>()
        let stopReason: StopReason = "end_turn"
        let buffer = ""
        let pendingEvent = ""
        const handleEvent = (event: string, dataStr: string): void => {
          let json: Record<string, unknown>
          try {
            json = JSON.parse(dataStr) as Record<string, unknown>
          } catch {
            return
          }
          const type = json.type as string
          if (type === "content_block_start") {
            const index = json.index as number
            const block = json.content_block as Record<string, unknown>
            if (block?.type === "tool_use") {
              const slot = toolBuffer.size
              toolBuffer.set(slot, {
                id: String(block.id ?? ""),
                name: String(block.name ?? ""),
                args: "",
              })
              toolIndexByBlock.set(index, slot)
              if (block.input && typeof block.input === "object") {
                const s = JSON.stringify(block.input)
                if (s !== "{}") {
                  const cur = toolBuffer.get(slot)
                  if (cur) cur.args = s
                }
              }
            }
          } else if (type === "content_block_delta") {
            const index = json.index as number
            const delta = json.delta as Record<string, unknown>
            if (!delta) return
            if (delta.type === "text_delta" && typeof delta.text === "string") {
              text.push(delta.text)
              callbacks?.onText?.(delta.text)
            } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
              thinking.push(delta.thinking)
              callbacks?.onThinking?.(delta.thinking)
            } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
              const slot = toolIndexByBlock.get(index)
              if (slot !== undefined) {
                const cur = toolBuffer.get(slot)
                if (cur) {
                  cur.args += delta.partial_json
                  callbacks?.onToolCallDelta?.(cur.name || undefined, cur.args)
                }
              }
            }
          } else if (type === "message_delta") {
            const delta = json.delta as Record<string, unknown> | undefined
            const reason = delta?.stop_reason as string | undefined
            if (reason) stopReason = mapAnthropicStop(reason)
          }
        }
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          receivedData = true
          buffer += chunk
          let nl: number
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            const trimmed = line.trim()
            if (trimmed.startsWith("event:")) {
              pendingEvent = trimmed.slice(6).trim()
              continue
            }
            if (!trimmed.startsWith("data:")) continue
            const payloadStr = trimmed.slice(5).trim()
            if (!payloadStr) continue
            handleEvent(pendingEvent, payloadStr)
            pendingEvent = ""
          }
        })
        res.on("end", () => {
          if (buffer.trim().startsWith("data:")) {
            handleEvent(pendingEvent, buffer.trim().slice(5).trim())
          }
          const content = this.assembleContent(text, thinking, toolBuffer)
          settle(() => resolve({ role: "assistant", content, stopReason }))
        })
        res.on("error", (err) => settle(() => reject(err)))
      })
      const firstByteTimer = setTimeout(() => {
        if (settled) return
        req.destroy()
        settle(() =>
          reject(
            new Error(
              `Provider did not respond within 60s (POST ${base.host}/v1/messages) — check the provider/endpoint, or Ctrl+D to abort`,
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
            this.postMessages(payload, signal, callbacks, /*retried*/ true).then(resolve, reject)
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

  protected assembleContent(
    text: string[],
    thinking: string[],
    toolBuffer: Map<number, { id: string; name: string; args: string }>,
  ): AssistantContentPart[] {
    const parts: AssistantContentPart[] = []
    if (thinking.length > 0) parts.push({ type: "thinking", text: thinking.join("") })
    if (text.length > 0) parts.push({ type: "text", text: text.join("") })
    let i = 0
    for (const entry of toolBuffer.values()) {
      let args: Record<string, unknown> = {}
      try {
        args = entry.args.trim() ? (JSON.parse(entry.args) as Record<string, unknown>) : {}
      } catch {
        args = { __raw: entry.args }
      }
      parts.push({ type: "toolCall", id: entry.id || `call_${i++}`, name: entry.name, arguments: args })
    }
    return parts
  }

  /** Exposed for model-list fetching: base URL + key header shape. */
  static modelsPath(): string {
    return "/v1/models"
  }
}

function mapAnthropicStop(reason: string): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use"
    case "max_tokens":
      return "length"
    case "end_turn":
    case "stop_sequence":
    default:
      return "end_turn"
  }
}

export function createAnthropicProvider(options: ProviderOptions): Provider {
  return new AnthropicProvider(options)
}

/** Wire-format helper: convert OpenAI-style messages to Anthropic body (unit-tested). */
export function toAnthropicBody(
  input: { system?: string; messages: WireMessage[]; tools?: ToolDefinition[] },
  model: string,
): Record<string, unknown> {
  const p = new AnthropicProvider({ baseUrl: "https://api.anthropic.com", model })
  return p["buildBody"]({ messages: input.messages, system: input.system, tools: input.tools })
}
