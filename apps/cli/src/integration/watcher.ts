export * as TrayambakWatcher from "./watcher"

import { EventEmitter } from "events"

export interface WatcherConfig {
  readonly paths: readonly string[]
  readonly ignored: readonly string[]
  readonly debounce: number
}

export interface WatcherEvent {
  readonly type: "add" | "change" | "unlink" | "addDir" | "unlinkDir"
  readonly path: string
  readonly timestamp: Date
}

export class WatcherService extends EventEmitter {
  private config: WatcherConfig = {
    paths: [],
    ignored: ["node_modules", ".git", "dist", "build"],
    debounce: 100,
  }
  private watchers: Map<string, { close: () => void }> = new Map()

  configure(config: Partial<WatcherConfig>): void {
    this.config = { ...this.config, ...config }
  }

  watch(path: string): void {
    if (this.watchers.has(path)) return

    const watcher = {
      close: () => {
        this.watchers.delete(path)
      },
    }

    this.watchers.set(path, watcher)
    this.emit("start", { path })
  }

  unwatch(path: string): boolean {
    const watcher = this.watchers.get(path)
    if (!watcher) return false

    watcher.close()
    this.watchers.delete(path)
    this.emit("stop", { path })
    return true
  }

  emitEvent(event: WatcherEvent): void {
    this.emit("change", event)
  }

  getWatchedPaths(): string[] {
    return Array.from(this.watchers.keys())
  }

  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
  }
}

export const watcherService = new WatcherService()
