/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
