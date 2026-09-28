export * as TrayambakSessionTranscript from "./session-transcript"

export interface TranscriptMessage {
  readonly id: string
  readonly role: "user" | "assistant" | "system"
  readonly content: string
  readonly timestamp: Date
  readonly metadata?: Record<string, unknown>
}

export interface TranscriptOptions {
  readonly includeSystem?: boolean
  readonly includeMetadata?: boolean
  readonly format?: "markdown" | "json" | "text"
}

export class SessionTranscript {
  private messages: TranscriptMessage[] = []

  add(message: Omit<TranscriptMessage, "id" | "timestamp">): TranscriptMessage {
    const fullMessage: TranscriptMessage = {
      ...message,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date(),
    }
    this.messages.push(fullMessage)
    return fullMessage
  }

  get(id: string): TranscriptMessage | undefined {
    return this.messages.find((m) => m.id === id)
  }

  list(options: TranscriptOptions = {}): TranscriptMessage[] {
    let messages = [...this.messages]

    if (!options.includeSystem) {
      messages = messages.filter((m) => m.role !== "system")
    }

    if (!options.includeMetadata) {
      messages = messages.map(({ metadata: _metadata, ...rest }) => rest)
    }

    return messages
  }

  export(options: TranscriptOptions = {}): string {
    const messages = this.list(options)
    const format = options.format ?? "markdown"

    switch (format) {
      case "json":
        return JSON.stringify(messages, null, 2)
      case "text":
        return messages.map((m) => `[${m.timestamp.toISOString()}] ${m.role}: ${m.content}`).join("\n\n")
      case "markdown":
      default:
        return messages.map((m) => `### ${m.role}\n${m.content}`).join("\n\n")
    }
  }

  clear(): void {
    this.messages = []
  }

  count(): number {
    return this.messages.length
  }
}

export const sessionTranscript = new SessionTranscript()
