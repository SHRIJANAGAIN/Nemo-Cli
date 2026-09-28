/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AssistantMessage, StopReason, ToolDefinition } from "../../protocol/src/index.js"

/** A single chat message in SKT AI LABS-compatible wire format. */
export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  name?: string
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

export interface WireToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface ProviderOptions {
  /** Base URL of the llama.cpp server, e.g. http://localhost:8080 */
  baseUrl: string
  /** Model name as exposed by the server (or a GGUF file id). */
  model: string
  apiKey?: string
  temperature?: number
  topP?: number
  maxTokens?: number
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Reasoning effort level. Maps to reasoning_tokens in the request. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max"
  /** Display label / provider id (defaults to "llama.cpp"). */
  label?: string
  /** Extra chat template kwargs (e.g. NVIDIA NIM enable_thinking). */
  chatTemplateKwargs?: Record<string, unknown>
}

export interface StreamCallbacks {
  onText?: (delta: string) => void
  onThinking?: (delta: string) => void
  onToolCallDelta?: (name: string | undefined, argsSoFar: string) => void
}

export interface ChatInput {
  system?: string
  messages: WireMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  callbacks?: StreamCallbacks
}

export interface Provider {
  readonly id: string
  chat(input: ChatInput): Promise<AssistantMessage>
}

export type { AssistantMessage, StopReason, ToolDefinition }
