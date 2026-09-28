export * as TrayambakSessionCompaction from "./session-compaction"

export interface CompactionConfig {
  readonly maxTokens: number
  readonly targetTokens: number
  readonly preserveRecent: number
}

export interface CompactionResult {
  readonly compressed: boolean
  readonly originalTokens: number
  readonly compressedTokens: number
  readonly preservedMessages: number
}

export class SessionCompaction {
  private config: CompactionConfig = {
    maxTokens: 100000,
    targetTokens: 80000,
    preserveRecent: 10,
  }

  getConfig(): CompactionConfig {
    return this.config
  }

  setConfig(config: Partial<CompactionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }

  shouldCompact(messageCount: number, totalTokens: number): boolean {
    return totalTokens > this.config.maxTokens
  }

  compact(messages: Array<{ content: string; tokens?: number }>): CompactionResult {
    const originalTokens = messages.reduce((sum, m) => sum + (m.tokens ?? this.estimateTokens(m.content)), 0)
    const recent = messages.slice(-this.config.preserveRecent)
    const older = messages.slice(0, -this.config.preserveRecent)

    const compressedMessages = [
      ...older.map((m) => ({
        ...m,
        content: this.summarize(m.content),
        tokens: this.estimateTokens(this.summarize(m.content)),
      })),
      ...recent,
    ]

    const compressedTokens = compressedMessages.reduce(
      (sum, m) => sum + (m.tokens ?? this.estimateTokens(m.content)),
      0,
    )

    return {
      compressed: compressedTokens < originalTokens,
      originalTokens,
      compressedTokens,
      preservedMessages: recent.length,
    }
  }

  private summarize(text: string): string {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0)
    if (sentences.length <= 3) return text
    return sentences.slice(0, 3).join(".") + "..."
  }
}

export const sessionCompaction = new SessionCompaction()
