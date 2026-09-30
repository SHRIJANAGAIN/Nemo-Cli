/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
  /** Fill-in-the-middle completion (prefix/suffix). Absent when the backend has no FIM endpoint. */
  fim?(input: FimInput): Promise<FimResult>
}

export interface FimInput {
  /** Code before the cursor. */
  prompt: string
  /** Code after the cursor. */
  suffix?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface FimResult {
  text: string
}

export type { AssistantMessage, StopReason, ToolDefinition }
