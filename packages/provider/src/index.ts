/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { ToolCallPart } from "../../protocol/src/index.js"
import { LlamaCppProvider, createLlamaCppProvider } from "./llama-cpp.js"
import { NvidiaProvider, createNvidiaProvider } from "./nvidia.js"
import {
  OpenAIProvider,
  createOpenAIProvider,
  OpenAICompatibleProvider,
  createOpenAICompatibleProvider,
} from "./openai.js"
import { XAIProvider, createXAIProvider } from "./xai.js"
import { HuggingFaceProvider, createHuggingFaceProvider } from "./huggingface.js"
import { CustomProvider, createCustomProvider } from "./custom.js"
import { AnthropicProvider, createAnthropicProvider } from "./anthropic.js"
import { GoogleProvider, createGoogleProvider } from "./google.js"
import { OllamaProvider, createOllamaProvider } from "./ollama.js"
import {
  PROVIDER_CATALOG,
  fetchModelsForProvider,
  fetchModelsDetailed,
  getCatalogEntry,
  verifyProviderKey,
} from "./catalog.js"

export { LlamaCppProvider, createLlamaCppProvider, NvidiaProvider, createNvidiaProvider }
export { OpenAIProvider, createOpenAIProvider, createOpenAICompatibleProvider, OpenAICompatibleProvider }
export { XAIProvider, createXAIProvider }
export { HuggingFaceProvider, createHuggingFaceProvider, CustomProvider, createCustomProvider }
export { AnthropicProvider, createAnthropicProvider, GoogleProvider, createGoogleProvider }
export { OllamaProvider, createOllamaProvider }
export { PROVIDER_CATALOG, fetchModelsForProvider, fetchModelsDetailed, getCatalogEntry, verifyProviderKey }
export type { ModelFetchStatus, KeyCheck } from "./catalog.js"
export type { ChatInput, FimInput, FimResult, Provider, ProviderOptions, WireMessage, WireToolCall } from "./types.js"

/**
 * Fallback parser for models that cannot do native function calling. When the
 * assistant emits a fenced `<tool_call:6124c78e>` block, extract the JSON tool
 * invocation(s) and the surrounding prose separately.
 */
export function extractTextToolCalls(text: string): { prose: string; toolCalls: ToolCallPart[] } {
  const fenceRe = /<tool_call:6124c78e>\s*([\s\S]*?)\s*<\/tool_call>/g
  const toolCalls: ToolCallPart[] = []
  let prose = ""
  let lastIndex = 0
  let match: RegExpExecArray | null
  let counter = 0

  while ((match = fenceRe.exec(text)) !== null) {
    prose += text.slice(lastIndex, match.index)
    lastIndex = fenceRe.lastIndex
    const inner = match[1].trim()
    const parsed = tryParseInvocation(inner)
    if (parsed) {
      toolCalls.push({
        type: "toolCall",
        id: `call_${counter++}`,
        name: parsed.name,
        arguments: parsed.arguments,
      })
    }
  }
  prose += text.slice(lastIndex)
  return { prose: prose.trim(), toolCalls }
}

function tryParseInvocation(raw: string): { name: string; arguments: Record<string, unknown> } | null {
  try {
    const obj = JSON.parse(raw) as { name?: string; tool?: string; arguments?: unknown; parameters?: unknown }
    const name = obj.name ?? obj.tool
    if (typeof name !== "string") return null
    const args = (obj.arguments ?? obj.parameters ?? {}) as Record<string, unknown>
    return { name, arguments: args }
  } catch {
    return null
  }
}
