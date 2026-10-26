/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolCallPart } from "../../protocol/src/index.js"
import { LlamaCppProvider, createLlamaCppProvider } from "./llama-cpp.js"
import { NvidiaProvider, createNvidiaProvider } from "./nvidia.js"
import { CustomProvider, createCustomProvider } from "./custom.js"
import { OllamaProvider, createOllamaProvider } from "./ollama.js"
import {
  PROVIDER_CATALOG,
  fetchModelsForProvider,
  fetchModelsDetailed,
  getCatalogEntry,
  verifyProviderKey,
} from "./catalog.js"

export { LlamaCppProvider, createLlamaCppProvider, NvidiaProvider, createNvidiaProvider }
export { CustomProvider, createCustomProvider }
export { OllamaProvider, createOllamaProvider }
export { PROVIDER_CATALOG, fetchModelsForProvider, fetchModelsDetailed, getCatalogEntry, verifyProviderKey }
export type { ModelFetchStatus, KeyCheck } from "./catalog.js"
export type { ChatInput, FimInput, FimResult, Provider, ProviderOptions, WireMessage, WireToolCall } from "./types.js"
export { clampTemperature } from "./types.js"

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
