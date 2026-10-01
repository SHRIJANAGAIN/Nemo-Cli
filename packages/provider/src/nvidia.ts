/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as http from "http"
import * as https from "https"
import * as url from "url"
import type { AssistantMessage, AssistantContentPart, StopReason, ToolDefinition } from "../../protocol/src/index.js"
import type { ChatInput, FimInput, FimResult, Provider, ProviderOptions, WireMessage } from "./types.js"
import { clampTemperature } from "./types.js"

interface SktTool {
  type: "function"
  function: { name: string; description: string; parameters: unknown }
}

/** Keep-alive agents for NVIDIA's API. */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 })

/** Transient network errors worth one automatic retry. */
function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? ""
  return code === "ECONNRESET" || code === "EPIPE" || /socket hang up|ECONNRESET|EPIPE|connection closed/i.test(msg)
}

function toSktTools(tools: ToolDefinition[]): SktTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

/**
 * Streaming client for NVIDIA's OpenAI-compatible API
 * (https://integrate.api.nvidia.com/v1/chat/completions).
 * Supports native function calling and streams text, reasoning/thought tokens, and tool calls.
 */
export class NvidiaProvider implements Provider {
  readonly id: string = "nvidia"

  /** Overridable error prefix, e.g. "OpenAI API" renders "OpenAI API returned 400: …". */
  protected apiErrorPrefix = "NVIDIA API"

  constructor(protected readonly options: ProviderOptions) {
    const normalized = options.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")
    this.options = { ...options, baseUrl: normalized }
  }

  async chat(input: ChatInput): Promise<AssistantMessage> {
    const body = this.buildBody(input)
    const raw = await this.postJson("/v1/chat/completions", body, input.signal, input.callbacks)
    return raw
  }

  /**
   * Fill-in-the-middle completion over the legacy `/v1/completions` API
   * (prompt + suffix), served by vLLM/Ollama/local servers and most
   * OpenAI-compatible gateways. Subclasses inherit it; backends without a
   * completions endpoint surface an honest error instead of hanging.
   */
  async fim(input: FimInput): Promise<FimResult> {
    if (!input.prompt) throw new Error("FIM prompt must not be empty")
    const body: Record<string, unknown> = {
      model: this.options.model,
      prompt: input.prompt,
      max_tokens: input.maxTokens ?? 256,
      temperature: clampTemperature(input.temperature, 0.2, 2),
      stream: false,
    }
    if (input.suffix !== undefined && input.suffix.length > 0) body.suffix = input.suffix
    const text = await this.postCompletion("/v1/completions", body, input.signal)
    return { text }
  }

  protected postCompletion(path: string, payload: unknown, signal: AbortSignal | undefined): Promise<string> {
    const base = new url.URL(this.options.baseUrl.replace(/\/+$/, ""))
    const isHttps = base.protocol === "https:"
    const lib = isHttps ? https : http
    const data = JSON.stringify(payload)

    return new Promise<string>((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      const req = lib.request(
        {
          method: "POST",
          hostname: base.hostname,
          port: base.port || (isHttps ? 443 : 80),
          path: (base.pathname && base.pathname !== "/" ? base.pathname.replace(/\/$/, "") : "") + path,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
            ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
          },
          timeout: this.options.timeoutMs ?? 600_000,
          agent: isHttps ? httpsAgent : httpAgent,
        },
        (res) => {
          let buf = ""
          res.setEncoding("utf8")
          res.on("data", (c) => {
            buf += c
            if (buf.length > 512 * 1024) req.destroy()
          })
          res.on("end", () => {
            const status = res.statusCode ?? 0
            if (status >= 400) {
              settle(() => reject(new Error(`${this.apiErrorPrefix} FIM returned ${status}: ${buf.slice(0, 200)}`)))
              return
            }
            try {
              const json = JSON.parse(buf) as { choices?: Array<{ text?: string }> }
              settle(() => resolve(json.choices?.[0]?.text ?? ""))
            } catch {
              settle(() => reject(new Error(`${this.apiErrorPrefix} FIM unreadable response`)))
            }
          })
          res.on("error", (err) => settle(() => reject(err)))
        },
      )
      req.on("timeout", () => {
        req.destroy()
        settle(() => reject(new Error("Request timed out")))
      })
      req.on("error", (err) => settle(() => reject(err)))
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

  protected applyReasoning(body: Record<string, unknown>): void {
    // NVIDIA reasoning_tokens hook — subclasses override (OpenAI uses
    // reasoning_effort; xAI/HF/custom send none).
    if (this.options.reasoningEffort) {
      const effortMap: Record<string, number | undefined> = {
        low: 10,
        medium: 20,
        high: 40,
        xhigh: 120,
        max: undefined,
      }
      const tokens = effortMap[this.options.reasoningEffort]
      if (tokens !== undefined) {
        body.reasoning_tokens = tokens
      } else {
        body.reasoning_tokens = 8192
      }
    }
  }

  protected buildBody(input: ChatInput): Record<string, unknown> {
    const messages: WireMessage[] = []
    if (input.system) {
      messages.push({ role: "system", content: input.system })
    }
    for (const m of input.messages) {
      messages.push(m)
    }

    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      stream: true,
      temperature: clampTemperature(this.options.temperature, 0.7, 2),
      top_p: this.options.topP ?? 0.95,
      max_tokens: this.options.maxTokens ?? 4096,
    }

    this.applyReasoning(body)

    if (input.tools && input.tools.length > 0) {
      body.tools = toSktTools(input.tools)
      body.tool_choice = "auto"
      body.parallel_tool_calls = false
    }
    return body
  }

  protected postJson(
    path: string,
    payload: unknown,
    signal: AbortSignal | undefined,
    callbacks: ChatInput["callbacks"],
    retried = false,
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
        path: (base.pathname && base.pathname !== "/" ? base.pathname.replace(/\/$/, "") : "") + path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Accept: "text/event-stream",
          Connection: "keep-alive",
        },
        timeout: this.options.timeoutMs ?? 600_000,
        agent: isHttps ? httpsAgent : httpAgent,
      }
      if (this.options.apiKey) {
        ;(options.headers as Record<string, string>)["Authorization"] = `Bearer ${this.options.apiKey}`
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
            const errMsg = buf.slice(0, 500)
            // If the model doesn't support `reasoning_tokens`, retry once without it.
            if (!retried && /reasoning_tokens|Unsupported parameter/i.test(errMsg)) {
              try {
                const modifiedPayload = { ...(payload as Record<string, unknown>) }
                delete modifiedPayload.reasoning_tokens
                setTimeout(
                  () => this.postJson(path, modifiedPayload, signal, callbacks, /*retried*/ true).then(resolve, reject),
                  0,
                )
              } catch {
                settle(() => reject(new Error(`${this.apiErrorPrefix} returned ${status}: ${errMsg}`)))
              }
              return
            }
            // For 429 rate-limited errors, include retry-after information for backoff.
            if (status === 429) {
              const retryAfter = res.headers["retry-after"]
              const err = new Error(`${this.apiErrorPrefix} returned ${status}: ${errMsg}`) as Error & {
                retryAfter?: string
              }
              if (retryAfter) err.retryAfter = retryAfter
              settle(() => reject(err))
              return
            }
            settle(() => reject(new Error(`${this.apiErrorPrefix} returned ${status}: ${errMsg}`)))
          })
          res.on("error", (err) =>
            settle(() => reject(new Error(`${this.apiErrorPrefix} returned ${status}: ${err.message}`))),
          )
          return
        }

        const text: string[] = []
        const thinking: string[] = []
        const toolBuffer = new Map<number, { id: string; name: string; args: string }>()
        let stopReason: StopReason = "end_turn"
        let buffer = ""

        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          receivedData = true
          buffer += chunk
          let nlIndex: number
          while ((nlIndex = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nlIndex).trim()
            buffer = buffer.slice(nlIndex + 1)
            if (!line.startsWith("data:")) continue
            const payload = line.slice(5).trim()
            if (payload === "[DONE]") continue
            try {
              const json = JSON.parse(payload)
              this.handleDelta(json, text, thinking, toolBuffer, callbacks)
              if (json.choices?.[0]?.finish_reason) {
                stopReason = mapFinishReason(json.choices[0].finish_reason)
              }
            } catch {
              // ignore malformed keep-alive lines
            }
          }
        })

        res.on("end", () => {
          if (text.length === 0 && thinking.length > 0) {
            const fullText = thinking.join("")
            callbacks?.onText?.(fullText)
            text.push(fullText)
          }
          const content = this.assembleContent(text, thinking, toolBuffer)
          settle(() => resolve({ role: "assistant", content, stopReason }))
        })
        res.on("error", (err) => settle(() => reject(err)))
      })

      // Time-to-first-byte watchdog: `timeout` above is a 10-minute SOCKET
      // IDLE timer — a provider that accepts the connection but never
      // answers holds the TUI on "Thinking…" that long before any error
      // surfaces ("thinking stuck, no response coming"). Response headers
      // normally arrive in seconds; give up at 60s with an actionable error.
      const firstByteTimer = setTimeout(() => {
        if (settled) return
        req.destroy()
        settle(() =>
          reject(
            new Error(
              `Provider did not respond within 60s (POST ${base.host}${path}) — check the provider/endpoint, or Ctrl+D to abort`,
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
            this.postJson(path, payload, signal, callbacks, /*retried*/ true).then(resolve, reject)
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

  protected handleDelta(
    json: unknown,
    text: string[],
    thinking: string[],
    toolBuffer: Map<number, { id: string; name: string; args: string }>,
    callbacks: ChatInput["callbacks"],
  ): void {
    if (!json || typeof json !== "object") return
    const choices = (json as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices
    const delta = choices?.[0]?.delta
    if (!delta) return

    const content = typeof delta.content === "string" ? delta.content : ""

    if (typeof delta.reasoning_content === "string") {
      thinking.push(delta.reasoning_content)
      callbacks?.onThinking?.(delta.reasoning_content)
    } else if (typeof delta.reasoning === "string") {
      thinking.push(delta.reasoning)
      callbacks?.onThinking?.(delta.reasoning)
    }

    if (content) {
      text.push(content)
      callbacks?.onText?.(content)
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of (delta.tool_calls ?? []) as unknown as Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>) {
        const index = tc.index ?? 0
        const existing = toolBuffer.get(index) ?? { id: "", name: "", args: "" }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (typeof tc.function?.arguments === "string") existing.args += tc.function.arguments
        toolBuffer.set(index, existing)
        callbacks?.onToolCallDelta?.(existing.name || undefined, existing.args ?? "")
      }
    }
  }

  protected assembleContent(
    text: string[],
    thinking: string[],
    toolBuffer: Map<number, { id: string; name: string; args: string }>,
  ): AssistantContentPart[] {
    const parts: AssistantContentPart[] = []
    if (thinking.length > 0) {
      parts.push({ type: "thinking", text: thinking.join("") })
    }
    if (text.length > 0) {
      parts.push({ type: "text", text: text.join("") })
    }
    const toolCalls: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }[] = []
    for (const entry of toolBuffer.values()) {
      const args = parseToolArgs(entry.args)
      toolCalls.push({
        type: "toolCall",
        id: entry.id || `call_${toolCalls.length}`,
        name: entry.name,
        arguments: args,
      })
    }
    parts.push(...toolCalls)
    return parts
  }
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use"
    case "length":
      return "length"
    case "abort":
      return "aborted"
    case "stop":
    default:
      return "end_turn"
  }
}

function parseToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    const sanitized = trimmed.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    const open = (sanitized.match(/\{/g) ?? []).length
    const close = (sanitized.match(/\}/g) ?? []).length
    if (open > close) {
      try {
        return JSON.parse(trimmed + "}".repeat(open - close)) as Record<string, unknown>
      } catch {
        // fall through
      }
    }
    return { __raw: trimmed }
  }
}

export function createNvidiaProvider(options: ProviderOptions): Provider {
  return new NvidiaProvider(options)
}
