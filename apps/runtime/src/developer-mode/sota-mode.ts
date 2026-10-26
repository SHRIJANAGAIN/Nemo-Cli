/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { WireMessage } from "../../../../packages/provider/src/index.js"
import { SotaReasoningEngine, type SotaOptions } from "../agent/sota.js"
import { CotChainEngine, DEFAULT_COT_CHAIN_CONFIG, type CotChainConfig } from "../../../../nemo/5-eval/cot-chain.js"

export interface SotaDevModeOptions {
  generate: (
    system: string,
    messages: WireMessage[],
    options?: { temperature?: number; maxTokens?: number },
  ) => Promise<string>
  verify?: (
    problem: string,
    solution: string,
  ) => Promise<{
    correctness: "PASS" | "FAIL" | "UNCERTAIN"
    evidence: string[]
    consistency: number
    progress: number
    confidence: number
    critique?: string
  }>
  execute?: (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>
  testCode?: (code: string, tests: string) => Promise<{ passed: boolean; output: string }>
  onEvent?: (event: { type: string; [key: string]: unknown }) => void
  signal?: AbortSignal
  maxCandidates?: number
  cotChainConfig?: Partial<CotChainConfig>
}

export class SotaDevMode {
  enabled: boolean
  private engine: SotaReasoningEngine | null = null
  private cotEngine: CotChainEngine | null = null
  private options: SotaDevModeOptions
  private cotConfig: CotChainConfig

  constructor(options: SotaDevModeOptions) {
    this.options = options
    this.enabled = false
    this.cotConfig = { ...DEFAULT_COT_CHAIN_CONFIG, ...(options.cotChainConfig ?? {}) }
  }

  toggle(value: boolean): void {
    this.enabled = value
    if (value && !this.engine) {
      const sotaOpts: SotaOptions = {
        generate: this.options.generate,
        verify: this.options.verify,
        execute: this.options.execute,
        testCode: this.options.testCode,
        onEvent: this.options.onEvent,
        signal: this.options.signal,
        maxCandidates: this.options.maxCandidates,
      }
      this.engine = new SotaReasoningEngine(sotaOpts)
    }
    if (value && this.cotConfig && !this.cotEngine) {
      this.cotEngine = new CotChainEngine(
        {
          generate: this.options.generate,
          verify: this.options.verify,
          execute: this.options.execute,
          testCode: this.options.testCode,
          onEvent: this.options.onEvent,
          signal: this.options.signal,
          maxCandidates: this.options.maxCandidates,
        },
        this.cotConfig,
      )
    }
  }

  setCotConfig(config: Partial<CotChainConfig>): void {
    this.cotConfig = { ...this.cotConfig, ...config }
    if (this.cotEngine) {
      this.cotEngine.config = { ...DEFAULT_COT_CHAIN_CONFIG, ...this.cotConfig }
    }
  }

  isCotChainEnabled(): boolean {
    return this.cotConfig.enabled
  }

  getCotConfig(): CotChainConfig {
    return { ...this.cotConfig }
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.options.signal = signal
    this.engine?.setSignal(signal)
    this.cotEngine?.setSignal(signal)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  async runSotaReasoning(problem: string): Promise<{
    solution: string
    confidence: number
    events: Array<{ type: string; [key: string]: unknown }>
  }> {
    if (this.cotConfig.enabled && this.cotEngine) {
      const events: Array<{ type: string; [key: string]: unknown }> = []
      this.cotEngine.setOnEvent((event) => {
        events.push(event as { type: string; [key: string]: unknown })
        this.options.onEvent?.(event as { type: string; [key: string]: unknown })
      })
      this.cotEngine.setSignal(this.options.signal)
      const result = await this.cotEngine.solve(problem)
      if (!result) {
        return { solution: "", confidence: 0, events }
      }
      return {
        solution: result.text,
        confidence: result.verification.confidence,
        events,
      }
    }

    if (!this.engine) {
      throw new Error("SOTA mode not initialized. Call toggle(true) first.")
    }
    const events: Array<{ type: string; [key: string]: unknown }> = []
    this.engine.setOnEvent((event) => {
      events.push(event as { type: string; [key: string]: unknown })
      this.options.onEvent?.(event as { type: string; [key: string]: unknown })
    })
    const result = await this.engine.solve(problem)
    if (!result) {
      return { solution: "", confidence: 0, events }
    }
    return {
      solution: result.text,
      confidence: result.verification.confidence,
      events,
    }
  }
}
