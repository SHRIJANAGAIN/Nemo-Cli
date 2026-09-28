export * as TrayambakTextStream from "./text-stream"

export interface StreamOptions {
  readonly onChunk?: (chunk: string) => void
  readonly onComplete?: (full: string) => void
  readonly onError?: (error: Error) => void
  readonly bufferSize?: number
}

export class TextStreamService {
  private buffer: string[] = []
  private bufferSize: number = 1024 * 1024

  stream(text: string, options: StreamOptions = {}): void {
    const chunks = text.match(/.{1,100}/g) ?? [text]

    for (const chunk of chunks) {
      if (options.onChunk) {
        options.onChunk(chunk)
      }
      this.buffer.push(chunk)

      while (this.buffer.length > this.bufferSize) {
        this.buffer.shift()
      }
    }

    if (options.onComplete) {
      options.onComplete(this.buffer.join(""))
    }
  }

  getBuffered(): string {
    return this.buffer.join("")
  }

  clear(): void {
    this.buffer = []
  }

  setBufferSize(size: number): void {
    this.bufferSize = size
  }
}

export const textStreamService = new TextStreamService()
