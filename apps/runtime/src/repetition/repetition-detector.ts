/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export type RepetitionLevel = "token" | "ngram" | "sentence" | "semantic" | "tool" | "strategy"

export interface RepetitionResult {
  level: RepetitionLevel
  count: number
  sample?: string
}

export class RepetitionDetector {
  private readonly tokenCounts = new Map<string, number>()
  private readonly ngramCounts = new Map<string, number>()
  private readonly sentenceCounts = new Map<string, number>()
  private readonly toolCalls: string[] = []
  private readonly strategies: string[] = []
  private readonly history: string[] = []

  record(text: string, toolCall?: string, strategy?: string): void {
    this.history.push(text)
    const tokens = text.split(/\s+/)
    for (const token of tokens) {
      const count = this.tokenCounts.get(token) ?? 0
      this.tokenCounts.set(token, count + 1)
    }
    for (let n = 2; n <= 5; n++) {
      for (let i = 0; i <= tokens.length - n; i++) {
        const ngram = tokens.slice(i, i + n).join(" ")
        const count = this.ngramCounts.get(ngram) ?? 0
        this.ngramCounts.set(ngram, count + 1)
      }
    }
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)
    for (const sentence of sentences) {
      const count = this.sentenceCounts.get(sentence.trim()) ?? 0
      this.sentenceCounts.set(sentence.trim(), count + 1)
    }
    if (toolCall) this.toolCalls.push(toolCall)
    if (strategy) this.strategies.push(strategy)
  }

  detect(): RepetitionResult[] {
    const results: RepetitionResult[] = []

    const repeatedToken = Array.from(this.tokenCounts.entries()).find(([, count]) => count >= 10)
    if (repeatedToken) {
      results.push({ level: "token", count: repeatedToken[1], sample: repeatedToken[0] })
    }

    const repeatedNgram = Array.from(this.ngramCounts.entries()).find(([, count]) => count >= 5)
    if (repeatedNgram) {
      results.push({ level: "ngram", count: repeatedNgram[1], sample: repeatedNgram[0] })
    }

    const repeatedSentence = Array.from(this.sentenceCounts.entries()).find(([, count]) => count >= 3)
    if (repeatedSentence) {
      results.push({ level: "sentence", count: repeatedSentence[1], sample: repeatedSentence[0] })
    }

    const toolCounts = new Map<string, number>()
    for (const tool of this.toolCalls) {
      const count = toolCounts.get(tool) ?? 0
      toolCounts.set(tool, count + 1)
    }
    const repeatedTool = Array.from(toolCounts.entries()).find(([, count]) => count >= 6)
    if (repeatedTool) {
      results.push({ level: "tool", count: repeatedTool[1], sample: repeatedTool[0] })
    }

    const strategyCounts = new Map<string, number>()
    for (const s of this.strategies) {
      const count = strategyCounts.get(s) ?? 0
      strategyCounts.set(s, count + 1)
    }
    const repeatedStrategy = Array.from(strategyCounts.entries()).find(([, count]) => count >= 4)
    if (repeatedStrategy) {
      results.push({ level: "strategy", count: repeatedStrategy[1], sample: repeatedStrategy[0] })
    }

    return results
  }

  reset(): void {
    this.tokenCounts.clear()
    this.ngramCounts.clear()
    this.sentenceCounts.clear()
    this.toolCalls.length = 0
    this.strategies.length = 0
  }
}
