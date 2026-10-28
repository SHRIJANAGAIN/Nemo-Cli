/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { randomUUID } from "node:crypto"
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
 * Fallback parser for models that cannot do native function calling. Every
 * `<tool_call>` / `<tool_call:id>` fence is extracted and the surrounding prose
 * kept separately.
 *
 * Fences are split one tag at a time rather than matched in open/close pairs:
 * models frequently emit nested opens (`<tool_call>` twice, `</tool_call>`
 * once) or drop the closing tag, and a paired regex then swallows the whole
 * run, leaving the raw syntax in the transcript and executing nothing.
 *
 * Two body dialects are accepted: JSON (`{"name":…,"arguments":{…}}`,
 * OpenAI-ish) and the XML form produced by Nemotron/Qwen-style templates
 * (`<function=f><parameter=p>v</parameter></function>`).
 *
 * The tag suffix is free-form: models invent their own ids, so matching one
 * specific literal makes every other id fall through as plain text — the call
 * then never runs and the model repeats it forever.
 */
export function extractTextToolCalls(text: string): { prose: string; toolCalls: ToolCallPart[] } {
  const toolCalls: ToolCallPart[] = []
  let prose = ""
  let inside = false

  for (const part of text.split(/(<\/?tool_call(?::[^>\s]+)?>)/)) {
    if (!part) continue
    if (/^<\/?tool_call(?::[^>\s]+)?>$/.test(part)) {
      inside = !part.startsWith("</")
      continue
    }
    if (!inside) {
      prose += part
      continue
    }
    const parsed = parseInvocations(part)
    if (parsed.length === 0) {
      prose += part
      continue
    }
    for (const invocation of parsed) {
      toolCalls.push({
        type: "toolCall",
        id: `call_${randomUUID()}`,
        name: invocation.name,
        arguments: invocation.arguments,
      })
    }
  }
  return { prose: stripTagFragments(prose).trim(), toolCalls }
}

/** Drops stray `<tool_call…>` fragments left by malformed or truncated output. */
function stripTagFragments(text: string): string {
  return text.replace(/<\/?tool_call[^>]*>/g, "")
}

function parseInvocations(segment: string): { name: string; arguments: Record<string, unknown> }[] {
  const whole = tryParseInvocation(segment.trim())
  if (whole) return [whole]
  const found: { name: string; arguments: Record<string, unknown> }[] = []
  for (const json of findJsonObjects(segment)) {
    const parsed = tryParseJsonInvocation(json)
    if (parsed) found.push(parsed)
  }
  return found
}

/** Balanced `{…}` spans, string- and escape-aware. */
function findJsonObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
      continue
    }
    if (ch === "}") {
      if (depth === 0) continue
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return out
}

function tryParseInvocation(raw: string): { name: string; arguments: Record<string, unknown> } | null {
  return tryParseJsonInvocation(raw) ?? tryParseXmlInvocation(raw)
}

function tryParseJsonInvocation(raw: string): { name: string; arguments: Record<string, unknown> } | null {
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

/**
 * `<function=list_dir><parameter=path>src</parameter></function>`. Parameter
 * values are coerced through JSON when possible so numbers, booleans and
 * nested objects keep their type; plain text stays a string.
 */
function tryParseXmlInvocation(raw: string): { name: string; arguments: Record<string, unknown> } | null {
  const fn = /<function=([^\s>]+)>([\s\S]*?)<\/function>/.exec(raw)
  if (!fn) return null
  const args: Record<string, unknown> = {}
  const paramRe = /<parameter=([^\s>]+)>\s*([\s\S]*?)\s*<\/parameter>/g
  let param: RegExpExecArray | null
  while ((param = paramRe.exec(fn[2])) !== null) {
    args[param[1]] = coerceParamValue(param[2])
  }
  return { name: fn[1], arguments: args }
}

function coerceParamValue(raw: string): unknown {
  const value = raw.trim()
  if (value === "") return ""
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
