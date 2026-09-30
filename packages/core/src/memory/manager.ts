/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { AgentMessage } from "../../../protocol/src/index.js"
import type { MemoryProvider } from "./provider.js"
import { isTrivialPrompt } from "./provider.js"

export interface MemoryManagerConfig {
  provider?: MemoryProvider
  trayambakHome: string
  profile?: string
  prefetchTimeoutMs?: number
  syncTimeoutMs?: number
}

export class MemoryManager {
  private readonly config: MemoryManagerConfig
  private provider: MemoryProvider | null
  private initialized = false

  constructor(config: MemoryManagerConfig) {
    this.config = config
    this.provider = config.provider ?? null
  }

  async initialize(): Promise<void> {
    if (!this.provider || this.initialized) return
    try {
      await this.provider.initialize({
        trayambakHome: this.config.trayambakHome,
        profile: this.config.profile,
      })
      this.initialized = true
    } catch {
      this.provider = null
    }
  }

  async shutdown(): Promise<void> {
    if (!this.provider) return
    try {
      await this.provider.shutdown()
    } catch {
      // ignore shutdown errors
    } finally {
      this.provider = null
      this.initialized = false
    }
  }

  async systemPromptBlock(): Promise<string> {
    if (!this.provider || !this.initialized) return ""
    try {
      return await this.provider.systemPromptBlock()
    } catch {
      return ""
    }
  }

  async prefetch(prompt: string): Promise<string> {
    if (!this.provider || !this.initialized) return ""
    if (isTrivialPrompt(prompt)) return ""
    try {
      const timeout = this.config.prefetchTimeoutMs ?? 8_000
      return await Promise.race([
        this.provider.prefetch(prompt),
        new Promise<string>((resolve) => setTimeout(() => resolve(""), timeout)),
      ])
    } catch {
      return ""
    }
  }

  async syncTurn(turn: AgentMessage[]): Promise<void> {
    if (!this.provider || !this.initialized) return
    try {
      const timeout = this.config.syncTimeoutMs ?? 5_000
      await Promise.race([
        this.provider.syncTurn(turn),
        new Promise<void>((resolve) => setTimeout(() => resolve(), timeout)),
      ])
    } catch {
      // ignore sync errors
    }
  }

  isTrivialPrompt(prompt: string): boolean {
    if (!this.provider) return isTrivialPrompt(prompt)
    return this.provider.isTrivialPrompt(prompt)
  }
}
