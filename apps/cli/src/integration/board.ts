export * as TrayambakBoard from "./board"

export interface BoardMessage {
  readonly id: string
  readonly author: string
  readonly content: string
  readonly timestamp: Date
  readonly recipient?: string
}

export interface BoardStore {
  readonly messages: BoardMessage[]
  readonly participants: Set<string>
}

import { uniqueId } from "./unique-id.js"

export class BoardService {
  private store: { messages: BoardMessage[]; participants: Set<string> } = {
    messages: [],
    participants: new Set(["local"]),
  }

  post(message: Omit<BoardMessage, "id" | "timestamp">): BoardMessage {
    const fullMessage: BoardMessage = {
      ...message,
      // Messages minted in the same millisecond used to share an id.
      id: uniqueId(
        `board-${Date.now()}`,
        this.store.messages.map((m) => m.id),
      ),
      timestamp: new Date(),
    }
    this.store.messages.push(fullMessage)
    this.store.participants.add(message.author)
    if (message.recipient) {
      this.store.participants.add(message.recipient)
    }
    return fullMessage
  }

  read(recipient?: string): BoardMessage[] {
    if (recipient === "ALL") {
      return [...this.store.messages]
    }
    return this.store.messages.filter((m) => !m.recipient || m.recipient === recipient)
  }

  getParticipants(): string[] {
    return Array.from(this.store.participants)
  }

  clear(): void {
    this.store.messages = []
  }
}

export const boardService = new BoardService()
