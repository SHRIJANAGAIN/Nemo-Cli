/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AgentMessage, AssistantMessage, ToolCallPart, ToolResultMessage } from "./messages.js"
import type { ToolResult } from "./tools.js"

/**
 * Events emitted by the agent loop. The CLI and TUI subscribe to these to
 * render streaming output without coupling to the internal loop machinery.
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "thinking"; thinking: string }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update"
      message: AssistantMessage
      delta: { text?: string; thinking?: string; toolCall?: Partial<ToolCallPart> }
    }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: ToolResult }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: ToolResult; isError: boolean }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown>; callId?: string }
  | {
      type: "tool_result"
      id: string
      result: { stdout?: string; stderr?: string; exitCode?: number; error?: string }
      callId?: string
    }
  | { type: "permission_request"; id: string; tool: string; args: unknown; reason: string; forceAsk?: boolean }
  | { type: "permission_response"; id: string; allowed: boolean }
  | {
      type: "subagent_start"
      subagentId: string
      name: string
      prompt: string
      subagentType?: string
      isolation?: string
    }
  | { type: "subagent_end"; subagentId: string; name: string; result: string }
  | { type: "subagent_fail"; subagentId: string; name: string; error: string }
  | {
      type: "subagent_background_start"
      subagentId: string
      name: string
      prompt: string
      subagentType?: string
      isolation?: string
    }
  | { type: "subagent_background_end"; subagentId: string; name: string; result: string }
  | { type: "subagent_background_fail"; subagentId: string; name: string; error: string }
  | { type: "mcp_start"; serverName: string }
  | { type: "mcp_end"; serverName: string; toolCount: number }
  | { type: "mcp_fail"; serverName: string; error: string }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "verification_start" }
  | { type: "verification_step"; name: string; status: "pass" | "fail" | "skip"; detail?: string; duration?: number }
  | {
      type: "verification_end"
      passed: boolean
      steps: Array<{ name: string; status: "pass" | "fail" | "skip"; detail?: string; duration?: number }>
    }
  | { type: "ready_for_verification"; path: string }
  | { type: "agent_end"; messages: AgentMessage[] }
  /** The rollout budget ran out: the loop stops here (never silently
   *  continues). `max: -1` means the budget itself was unlimited and a turn
   *  cap ended the run; usage numbers are ESTIMATED (ceil(chars / 4)). */
  | { type: "budget_exhausted"; used: number; max: number; remaining: number }
  | {
      type: "compaction"
      removedMessages: number
      prunedToolOutputs: number
      freedTokens: number
      estimatedBefore: number
      estimatedAfter: number
    }

/**
 * Background job info for tracking asynchronous subagent tasks.
 */
export interface BackgroundJobInfo {
  id: string
  type: "task"
  title?: string
  status: "running" | "completed" | "error" | "cancelled"
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

/**
 * List of active background jobs, keyed by job ID.
 */
export type BackgroundJobList = BackgroundJobInfo[]

/** Result of promoting a background job back to foreground. */
export interface BackgroundJobPromoteResult {
  id: string
  promoted: boolean
}

/**
 * The final result of an agent run, delivered when the agent loop completes.
 */
export interface AgentResult {
  messages: AgentMessage[]
}

/**
 * An AgentEvent tagged with the subagent loop that produced it. The runtime
 * tags every event emitted from a child (subagent) loop with `subagentId`
 * (+ `subagentName`) so UIs can route nested tool/streaming activity to the
 * subagent's card instead of the parent transcript. Plain AgentEvents remain
 * valid (both tag fields are optional).
 */
export type TaggedAgentEvent = AgentEvent & { subagentId?: string; subagentName?: string }

export type AgentEventSink = (event: TaggedAgentEvent) => void | Promise<void>
