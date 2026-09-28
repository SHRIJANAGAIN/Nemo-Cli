/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { SubagentTask, DeveloperModeConfig } from "./developer-mode.js"

export interface SubagentOrchestratorOptions {
  config: DeveloperModeConfig
  onTaskUpdate: (task: SubagentTask) => void
  onTaskComplete: (task: SubagentTask) => void
  onTaskFail: (task: SubagentTask, error: string) => void
  onCrossMonitor: (pairs: Array<{ agentA: SubagentTask; agentB: SubagentTask; status: string }>) => void
  subagentRunner?: (task: {
    name: string
    prompt: string
    subagentType?: string
    model?: string
    isolation?: string
  }) => Promise<string>
  /** When set, the orchestrator delegates execution to a real Agent.run instead of the mock fallback. */
  agentRunner?: (task: {
    name: string
    prompt: string
    subagentType?: string
    model?: string
    isolation?: string
  }) => Promise<string>
}

export interface SubagentEngine {
  startSubagent: (name: string, prompt: string, parentId?: string, peerId?: string) => SubagentTask
  updateSubagent: (id: string, patch: Partial<SubagentTask>) => boolean
  completeSubagent: (id: string, result: string) => boolean
  failSubagent: (id: string, error: string) => boolean
  cancelSubagent: (id: string) => boolean
  getActiveSubagents: () => SubagentTask[]
  getSubagent: (id: string) => SubagentTask | undefined
  crossMonitorSubagents: () => Array<{ agentA: SubagentTask; agentB: SubagentTask; status: string }>
}

export class SubagentOrchestrator {
  private readonly options: SubagentOrchestratorOptions
  private running = false
  private monitorTimer: ReturnType<typeof setInterval> | null = null
  private crossMonitorFn: (() => Array<{ agentA: SubagentTask; agentB: SubagentTask; status: string }>) | null = null

  constructor(options: SubagentOrchestratorOptions) {
    this.options = options
  }

  start(): void {
    if (this.running) return
    this.running = true
    if (this.options.config.parallelSubagents && this.options.config.subagentMonitorIntervalMs > 0) {
      this.monitorTimer = setInterval(() => {
        this.runCrossMonitor()
      }, this.options.config.subagentMonitorIntervalMs)
    }
  }

  stop(): void {
    this.running = false
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
  }

  async runTask(
    engine: SubagentEngine,
    name: string,
    prompt: string,
    parentId?: string,
    peerId?: string,
  ): Promise<SubagentTask> {
    const maxSubagents = this.options.config.maxSubagents
    this.crossMonitorFn = engine.crossMonitorSubagents
    const active = engine.getActiveSubagents()
    if (active.length >= maxSubagents) {
      const oldest = active[0]
      if (oldest) engine.cancelSubagent(oldest.id)
    }
    const task = engine.startSubagent(name, prompt, parentId, peerId)
    engine.updateSubagent(task.id, { status: "running", startedAt: Date.now() })
    this.options.onTaskUpdate(engine.getSubagent(task.id)!)
    try {
      const result = await this.executeSubagentPrompt(prompt, name)
      engine.completeSubagent(task.id, result)
      this.options.onTaskComplete(engine.getSubagent(task.id)!)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      engine.failSubagent(task.id, message)
      this.options.onTaskFail(engine.getSubagent(task.id)!, message)
    }
    return engine.getSubagent(task.id)!
  }

  async runParallelTasks(
    engine: SubagentEngine,
    tasks: Array<{ name: string; prompt: string }>,
    parentId?: string,
  ): Promise<SubagentTask[]> {
    const maxSubagents = this.options.config.maxSubagents
    const results: SubagentTask[] = []
    const batches: Array<{ name: string; prompt: string }>[] = []
    for (let i = 0; i < tasks.length; i += maxSubagents) {
      batches.push(tasks.slice(i, i + maxSubagents))
    }
    for (const batch of batches) {
      const promises = batch.map((t, idx) =>
        this.runTask(engine, t.name, t.prompt, parentId, idx > 0 ? results[results.length - 1]?.id : undefined),
      )
      const batchResults = await Promise.all(promises)
      results.push(...batchResults)
      this.runCrossMonitorOnEngine(engine)
    }
    return results
  }

  private runCrossMonitorOnEngine(engine: SubagentEngine): void {
    const pairs = engine.crossMonitorSubagents()
    if (pairs.length > 0) {
      this.options.onCrossMonitor(pairs)
    }
  }

  private runCrossMonitor(): void {
    if (!this.crossMonitorFn) return
    const pairs = this.crossMonitorFn()
    if (pairs.length > 0) {
      this.options.onCrossMonitor(pairs)
    }
  }

  private async executeSubagentPrompt(prompt: string, name?: string): Promise<string> {
    const task = { name: name ?? "specialist", prompt }
    if (this.options.agentRunner) {
      return this.options.agentRunner(task)
    }
    if (this.options.subagentRunner) {
      return this.options.subagentRunner(task)
    }
    throw new Error("No subagent runner configured; cannot execute subagent task.")
  }

  shouldAutoSpawnBugFix(eventType: string, errorCount: number): boolean {
    if (eventType === "tool_error" && errorCount >= 2) return true
    if (eventType === "permission_denied") return true
    if (eventType === "tui_error") return true
    return false
  }

  trySpawnBugFixSubagent(task: string, error: string): boolean {
    if (!this.running) return false
    try {
      const engine = (this as unknown as { engineRef?: { startSubagent: (n: string, p: string) => unknown } }).engineRef
      if (!engine || typeof engine.startSubagent !== "function") return false
      engine.startSubagent("bug-fix-specialist", "Fix: " + task + "\\nError: " + error.slice(0, 800))
      return true
    } catch {
      return false
    }
  }
}
