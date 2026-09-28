export * as TrayambakIndexing from "./indexing"

export interface IndexingConfig {
  readonly enabled: boolean
  readonly interval: number
  readonly maxFileSize: number
  readonly excludedPaths: readonly string[]
}

export interface IndexingState {
  readonly status: "idle" | "running" | "error"
  readonly progress: number
  readonly lastRun?: Date
  readonly error?: string
}

export class IndexingService {
  private config: IndexingConfig = {
    enabled: true,
    interval: 3600000,
    maxFileSize: 1024 * 1024,
    excludedPaths: ["node_modules", ".git", "dist", "build"],
  }
  private state: IndexingState = { status: "idle", progress: 0 }

  getConfig(): IndexingConfig {
    return this.config
  }

  setConfig(config: Partial<IndexingConfig>): void {
    this.config = { ...this.config, ...config }
  }

  getState(): IndexingState {
    return this.state
  }

  async run(): Promise<void> {
    this.state = { status: "running", progress: 0 }
    try {
      await this.indexFiles()
      this.state = { status: "idle", progress: 100, lastRun: new Date() }
    } catch (error) {
      this.state = {
        status: "error",
        progress: this.state.progress,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async indexFiles(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export const indexingService = new IndexingService()
