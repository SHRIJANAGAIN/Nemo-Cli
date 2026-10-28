/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it, vi } from "vitest"
import { SotaDevMode } from "./index.js"

const verify = async (): Promise<{
  correctness: "PASS" | "FAIL" | "UNCERTAIN"
  evidence: string[]
  consistency: number
  progress: number
  confidence: number
}> => ({
  correctness: "PASS",
  evidence: ["stubbed evidence"],
  consistency: 1,
  progress: 1,
  confidence: 0.9,
})

const makeGenerate = () => vi.fn(async () => "stub solution")

describe("SotaDevMode", () => {
  it("starts disabled and throws until toggle(true) initializes the engines", async () => {
    const mode = new SotaDevMode({ generate: makeGenerate(), verify })
    expect(mode.enabled).toBe(false)
    await expect(mode.runSotaReasoning("solve 1+1")).rejects.toThrow(
      "SOTA mode not initialized. Call toggle(true) first.",
    )
    mode.toggle(true)
    expect(mode.isEnabled()).toBe(true)
    mode.toggle(false)
    expect(mode.isEnabled()).toBe(false)
  })

  it("merges cot chain config over the defaults and returns copies", () => {
    const mode = new SotaDevMode({ generate: makeGenerate(), cotChainConfig: { maxDepth: 2 } })
    expect(mode.isCotChainEnabled()).toBe(false)
    expect(mode.getCotConfig().maxDepth).toBe(2)
    expect(mode.getCotConfig().branchFactor).toBe(3)
    const copy = mode.getCotConfig()
    copy.maxDepth = 99
    expect(mode.getCotConfig().maxDepth).toBe(2)
  })

  it("setCotConfig patches the config after the engines exist", () => {
    const mode = new SotaDevMode({ generate: makeGenerate() })
    mode.toggle(true)
    mode.setCotConfig({ branchFactor: 4, enabled: true })
    expect(mode.getCotConfig().branchFactor).toBe(4)
    expect(mode.isCotChainEnabled()).toBe(true)
  })

  it("runs the non-cot reasoning path and forwards events to onEvent", async () => {
    const generate = makeGenerate()
    const onEvent = vi.fn()
    const mode = new SotaDevMode({ generate, verify, onEvent })
    mode.toggle(true)

    const result = await mode.runSotaReasoning("fix the bug in the parser code")

    expect(result.solution).toBe("stub solution")
    expect(result.confidence).toBe(0.9)
    expect(result.events.some((e) => e.type === "difficulty_estimated")).toBe(true)
    expect(result.events.some((e) => e.type === "search_complete")).toBe(true)
    expect(onEvent).toHaveBeenCalled()
    expect(generate).toHaveBeenCalled()
  })

  it("runs the cot chain path when cotChainConfig.enabled is set", async () => {
    const generate = makeGenerate()
    const onEvent = vi.fn()
    const mode = new SotaDevMode({
      generate,
      verify,
      onEvent,
      cotChainConfig: { enabled: true, branchFactor: 2 },
    })
    mode.toggle(true)
    expect(mode.isCotChainEnabled()).toBe(true)

    const result = await mode.runSotaReasoning("write a function to parse dates")

    expect(result.solution).toBe("stub solution")
    expect(result.confidence).toBe(0.9)
    expect(result.events.some((e) => e.type === "difficulty_estimated")).toBe(true)
    expect(result.events.some((e) => e.type === "solution_found")).toBe(true)
    expect(onEvent).toHaveBeenCalled()
  })

  it("an aborted signal short-circuits the non-cot path to an empty result", async () => {
    const mode = new SotaDevMode({ generate: makeGenerate(), verify, signal: AbortSignal.abort() })
    mode.toggle(true)
    expect(await mode.runSotaReasoning("anything")).toEqual({ solution: "", confidence: 0, events: [] })
  })

  it("setSignal propagates to the engines: aborted signal empties the cot path too", async () => {
    const mode = new SotaDevMode({ generate: makeGenerate(), verify, cotChainConfig: { enabled: true } })
    mode.toggle(true)
    mode.setSignal(AbortSignal.abort())
    expect(await mode.runSotaReasoning("anything")).toEqual({ solution: "", confidence: 0, events: [] })
  })
})
