/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export type Role = "system" | "user" | "assistant" | "tool"

export interface TextPart {
  type: "text"
  text: string
}

export interface ThinkingPart {
  type: "thinking"
  text: string
}

export interface ToolCallPart {
  type: "toolCall"
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AssistantContentPart = TextPart | ThinkingPart | ToolCallPart

export interface SystemMessage {
  role: "system"
  content: string
}

export interface UserMessage {
  role: "user"
  content: string
  /** Attached pictures as `data:image/*;base64,...` URLs, in display order.
   *  Text-only backends silently drop these (anthropic/google build bodies
   *  that only read `content`), so an attach must never be load-bearing on
   *  its own — the prompt text always carries the meaning too. */
  images?: string[]
}

export interface AssistantMessage {
  role: "assistant"
  content: AssistantContentPart[]
  stopReason: StopReason
}

export interface ToolResultMessage {
  role: "tool"
  toolCallId: string
  toolName: string
  content: TextPart[]
  isError: boolean
  /** Pictures the tool produced, as `data:image/*;base64,...` URLs. See
   *  `ToolResult.images` — kept off `content` so every `.text` reader keeps
   *  working unchanged. */
  images?: string[]
}

export type StopReason = "end_turn" | "tool_use" | "length" | "aborted" | "error"

export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage

export function isAssistant(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant"
}

export function isToolResult(message: AgentMessage): message is ToolResultMessage {
  return message.role === "tool"
}

export function isUser(message: AgentMessage): message is UserMessage {
  return message.role === "user"
}
