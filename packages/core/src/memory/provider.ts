/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { AgentMessage } from "../../../protocol/src/index.js"

export interface MemoryProviderContext {
  trayambakHome: string
  profile?: string
}

export interface MemoryProvider {
  readonly name: string
  initialize(ctx: MemoryProviderContext): Promise<void> | void
  shutdown(): Promise<void> | void
  systemPromptBlock(): Promise<string> | string
  prefetch(query: string): Promise<string> | string
  syncTurn(turn: AgentMessage[]): Promise<void> | void
  isTrivialPrompt(prompt: string): boolean
}

export const TRIVIAL_PROMPTS = new Set([
  "hi",
  "hello",
  "hey",
  "ok",
  "okay",
  "continue",
  "go on",
  "yes",
  "no",
  "thanks",
  "thank you",
  "good",
  "great",
  "nice",
])

export function isTrivialPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase().trim()
  if (TRIVIAL_PROMPTS.has(normalized)) return true
  if (normalized.length <= 3) return true
  return false
}
