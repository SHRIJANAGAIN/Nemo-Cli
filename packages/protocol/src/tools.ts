/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * A minimal JSON-schema-like description of a tool's parameters.
 * This is intentionally small so it can be emitted both as a provider
 * function-tool schema (for llama.cpp) and as a human-readable list.
 */
export interface ToolParameterProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object"
  description: string
  enum?: string[]
  items?: ToolParameterProperty
}

export interface ToolParameters {
  type: "object"
  properties: Record<string, ToolParameterProperty>
  required: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameters
  /** When set, the tool runs sequentially relative to others in its batch. */
  executionMode?: "parallel" | "sequential"
  /** Upper bound (ms) the harness allows this tool to run — unbounded tools can wedge a turn. */
  timeoutMs?: number
}

export interface ToolResultContent {
  type: "text"
  text: string
}

export interface ToolResult {
  content: ToolResultContent[]
  isError: boolean
  /** When true, ends the current turn even if more tools are pending. */
  terminate?: boolean
}
