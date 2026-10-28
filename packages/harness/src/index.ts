/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

export type HarnessEvent =
  | { type: "session_start"; sessionId: string }
  | { type: "turn_start"; prompt: string }
  | { type: "turn_end"; prompt: string; success: boolean }
  | { type: "error"; prompt: string; error: string }

export interface HarnessState {
  version: 1
  sessionId: string
  facts: Record<string, string>
  events: HarnessEvent[]
  snapshots: Array<{ id: string; label: string; facts: Record<string, string>; createdAt: string }>
  updatedAt: string
}

export interface HarnessContext {
  cwd: string
  state: HarnessState
  setFact(key: string, value: string): void
  getFact(key: string): string | undefined
}

export interface HarnessPlugin {
  name: string
  setup?(context: HarnessContext): void | Promise<void>
  onEvent?(event: HarnessEvent, context: HarnessContext): void | Promise<void>
  context?(context: HarnessContext): string | undefined
}

export class HarnessRuntime {
  readonly state: HarnessState
  private readonly file: string
  private readonly plugins = new Map<string, HarnessPlugin>()
  private readonly contextValue: HarnessContext

  constructor(cwd: string, sessionId = `harness_${Date.now().toString(36)}`) {
    this.file = path.join(cwd, ".nemo", "harness.json")
    this.state = this.load(sessionId)
    this.contextValue = {
      cwd,
      state: this.state,
      setFact: (key, value) => {
        this.state.facts[key] = value
        this.persist()
      },
      getFact: (key) => this.state.facts[key],
    }
  }

  async register(plugin: HarnessPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) return
    this.plugins.set(plugin.name, plugin)
    await plugin.setup?.(this.contextValue)
    this.persist()
  }

  async emit(event: HarnessEvent): Promise<void> {
    for (const plugin of this.plugins.values()) {
      await plugin.onEvent?.(event, this.contextValue)
    }
    this.state.events.push(event)
    if (this.state.events.length > 100) this.state.events.shift()
    this.state.updatedAt = new Date().toISOString()
    this.persist()
  }

  snapshot(label: string): string {
    const id = `snapshot_${Date.now().toString(36)}`
    this.state.snapshots.push({
      id,
      label: label.trim() || "checkpoint",
      facts: { ...this.state.facts },
      createdAt: new Date().toISOString(),
    })
    if (this.state.snapshots.length > 20) this.state.snapshots.shift()
    this.persist()
    return id
  }

  rollback(id: string): void {
    const snapshot = this.state.snapshots.find((entry) => entry.id === id)
    if (!snapshot) throw new Error(`Harness snapshot not found: ${id}`)
    this.state.facts = { ...snapshot.facts }
    this.persist()
  }

  context(): string {
    const facts = Object.entries(this.state.facts)
      .map(([key, value]) => `  - ${key}: ${value}`)
      .join("\n")
    const blocks = [
      facts ? `Durable harness facts:\n${facts}` : "",
      ...[...this.plugins.values()]
        .map((plugin) => plugin.context?.(this.contextValue))
        .filter((value): value is string => Boolean(value?.trim())),
    ]
    return blocks.join("\n")
  }

  private load(sessionId: string): HarnessState {
    if (!fs.existsSync(this.file)) {
      return { version: 1, sessionId, facts: {}, events: [], snapshots: [], updatedAt: new Date().toISOString() }
    }
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<HarnessState>
    return {
      version: 1,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : sessionId,
      facts: parsed.facts && typeof parsed.facts === "object" ? (parsed.facts as Record<string, string>) : {},
      events: Array.isArray(parsed.events) ? parsed.events.slice(-100) : [],
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots.slice(-20) : [],
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), "utf8")
  }
}

export interface RecursiveTask<T> {
  name: string
  run: () => Promise<T>
}

export class RecursiveTaskRuntime {
  constructor(
    private readonly maxDepth = 3,
    private readonly maxParallel = 3,
  ) {}

  async run<T>(task: RecursiveTask<T>, depth = 0): Promise<T> {
    if (depth > this.maxDepth) throw new Error(`Recursive task depth exceeded (${this.maxDepth}).`)
    return task.run()
  }

  async runParallel<T>(tasks: Array<RecursiveTask<T>>, depth = 0): Promise<T[]> {
    if (tasks.length > this.maxParallel) {
      throw new Error(`Parallel task limit exceeded (${this.maxParallel}).`)
    }
    return Promise.all(tasks.map((task) => this.run(task, depth + 1)))
  }
}
