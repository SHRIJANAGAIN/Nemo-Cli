/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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

/** Mime types a vision backend will accept inline. */
export const SUPPORTED_IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const

export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIME)[number]

export interface ToolResult {
  content: ToolResultContent[]
  isError: boolean
  /** When true, ends the current turn even if more tools are pending. */
  terminate?: boolean
  /**
   * Pictures this tool produced, as `data:image/*;base64,...` URLs.
   *
   * A sibling of `content` rather than a variant inside it, for the same
   * reason `WireMessage.images` is: `content` is read as `TextPart[]` by the
   * agent loop, the TUI transcript, and every tool test, so widening it into a
   * discriminated union would have broken all of them for no gain. `content`
   * still carries the prose caption that tells the model what it is looking
   * at — an image here is never the only signal.
   *
   * `Session.toWireMessages` re-surfaces these as a synthetic user turn,
   * because no OpenAI-compatible endpoint accepts an image part on a
   * `role: "tool"` row.
   */
  images?: string[]
}

/** Data URLs a tool result carries, filtered to ones a backend can read. Pure. */
export function toolResultImages(result: Pick<ToolResult, "images">): string[] {
  if (!result.images || result.images.length === 0) return []
  return result.images.filter((u) => typeof u === "string" && u.startsWith("data:image/"))
}
