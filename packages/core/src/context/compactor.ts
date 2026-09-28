/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { AgentMessage } from "../../../protocol/src/index.js"

export interface CompactionResult {
  messages: AgentMessage[]
  summary: string
  removedCount: number
}

export interface CompactorOptions {
  maxTokens?: number
  reserveHead?: number
  reserveTail?: number
  summarizePrompt?: string
}

const DEFAULT_MAX_TOKENS = 120_000
const DEFAULT_RESERVE_HEAD = 4
const DEFAULT_RESERVE_TAIL = 8

export class ContextCompactor {
  private readonly maxTokens: number
  private readonly reserveHead: number
  private readonly reserveTail: number
  private readonly summarizePrompt: string

  constructor(options: CompactorOptions = {}) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    this.reserveHead = options.reserveHead ?? DEFAULT_RESERVE_HEAD
    this.reserveTail = options.reserveTail ?? DEFAULT_RESERVE_TAIL
    this.summarizePrompt =
      options.summarizePrompt ??
      "Summarize the following conversation history concisely, preserving key facts, decisions, and action items. Output only the summary."
  }

  needsCompaction(messages: AgentMessage[]): boolean {
    const estimate = this.estimateTokens(messages)
    return estimate > this.maxTokens
  }

  compact(messages: AgentMessage[]): CompactionResult {
    if (messages.length <= this.reserveHead + this.reserveTail) {
      return { messages, summary: "", removedCount: 0 }
    }

    const head = messages.slice(0, this.reserveHead)
    const tail = messages.slice(-this.reserveTail)
    const middle = messages.slice(this.reserveHead, messages.length - this.reserveTail)

    const summary = this.buildSummary(middle)
    const summaryMessage: AgentMessage = {
      role: "system",
      content: `[CONTEXT COMPACTION — REFERENCE ONLY]\n\n${summary}\n\n[END COMPACTION]`,
    }

    return {
      messages: [...head, summaryMessage, ...tail],
      summary,
      removedCount: middle.length,
    }
  }

  private buildSummary(messages: AgentMessage[]): string {
    const parts: string[] = []
    for (const msg of messages) {
      const role = msg.role
      const text = this.extractText(msg)
      if (text.trim()) {
        parts.push(`${role.toUpperCase()}: ${text.trim().slice(0, 500)}`)
      }
    }
    return parts.join("\n\n")
  }

  private extractText(msg: AgentMessage): string {
    if (typeof msg.content === "string") return msg.content
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => ("text" in c ? c.text : ""))
      .join(" ")
  }

  private estimateTokens(messages: AgentMessage[]): number {
    let total = 0
    for (const msg of messages) {
      const text = this.extractText(msg)
      total += Math.ceil(text.length / 4)
    }
    return total
  }
}
