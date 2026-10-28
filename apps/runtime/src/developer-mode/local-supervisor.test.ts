/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { getRolloutBudget } from "../../../../packages/core/src/rollout_budget.js"
import { estimateTokens, resetBudget } from "../../../../packages/core/src/token_budget.js"
import type { AssistantMessage } from "../../../../packages/protocol/src/index.js"
import type { Provider, ProviderOptions } from "../../../../packages/provider/src/types.js"
import {
  DEFAULT_LOCAL_SUPERVISOR_CONFIG,
  SUPERVISOR_MAX_HISTORY,
  SUPERVISOR_MAX_TIMEOUT_MS,
  isSupervisorConfigured,
  parseSupervisorDecision,
  requestSupervisorDecision,
  sanitizeSupervisorConfig,
  type LocalSupervisorConfig,
} from "./local-supervisor.js"

const configured: LocalSupervisorConfig = {
  provider: "nvidia",
  model: "judge-model",
  baseUrl: "",
  apiKey: "",
  timeoutMs: 15_000,
}

const textMessage = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "end_turn",
})

describe("isSupervisorConfigured", () => {
  it("is false for missing/empty/whitespace provider or model", () => {
    expect(isSupervisorConfigured()).toBe(false)
    expect(isSupervisorConfigured({ ...configured, provider: "", model: "" })).toBe(false)
    expect(isSupervisorConfigured({ ...configured, provider: "   " })).toBe(false)
    expect(isSupervisorConfigured({ ...configured, model: " " })).toBe(false)
  })

  it("is true when both provider and model are set", () => {
    expect(isSupervisorConfigured(configured)).toBe(true)
  })
})

describe("sanitizeSupervisorConfig", () => {
  it("falls back to defaults for non-object input", () => {
    expect(sanitizeSupervisorConfig(null)).toEqual(DEFAULT_LOCAL_SUPERVISOR_CONFIG)
    expect(sanitizeSupervisorConfig("nope")).toEqual(DEFAULT_LOCAL_SUPERVISOR_CONFIG)
    expect(sanitizeSupervisorConfig([1, 2])).toEqual(DEFAULT_LOCAL_SUPERVISOR_CONFIG)
    expect(sanitizeSupervisorConfig(42)).toEqual(DEFAULT_LOCAL_SUPERVISOR_CONFIG)
  })

  it("keeps valid fields and defaults invalid ones", () => {
    const out = sanitizeSupervisorConfig({ provider: "nvidia", model: 7, timeoutMs: "soon" })
    expect(out.provider).toBe("nvidia")
    expect(out.model).toBe(DEFAULT_LOCAL_SUPERVISOR_CONFIG.model)
    expect(out.timeoutMs).toBe(DEFAULT_LOCAL_SUPERVISOR_CONFIG.timeoutMs)
  })

  it("clamps timeoutMs into the sane window", () => {
    expect(sanitizeSupervisorConfig({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_LOCAL_SUPERVISOR_CONFIG.timeoutMs)
    expect(sanitizeSupervisorConfig({ timeoutMs: -5 }).timeoutMs).toBe(DEFAULT_LOCAL_SUPERVISOR_CONFIG.timeoutMs)
    expect(sanitizeSupervisorConfig({ timeoutMs: Number.NaN }).timeoutMs).toBe(
      DEFAULT_LOCAL_SUPERVISOR_CONFIG.timeoutMs,
    )
    expect(sanitizeSupervisorConfig({ timeoutMs: 500_000 }).timeoutMs).toBe(SUPERVISOR_MAX_TIMEOUT_MS)
    expect(sanitizeSupervisorConfig({ timeoutMs: 5 }).timeoutMs).toBe(1_000)
    expect(sanitizeSupervisorConfig({ timeoutMs: 9_000 }).timeoutMs).toBe(9_000)
  })
})

describe("parseSupervisorDecision", () => {
  it("parses a bare JSON object", () => {
    expect(parseSupervisorDecision('{"temperature":0.1,"maxToolCalls":6}')).toEqual({
      temperature: 0.1,
      maxToolCalls: 6,
    })
  })

  it("parses a fenced block and JSON embedded in prose", () => {
    expect(parseSupervisorDecision('```json\n{"temperature":0.3}\n```')).toEqual({ temperature: 0.3 })
    expect(parseSupervisorDecision('Sure! Here is the decision: {"stepByStep": true} — done.')).toEqual({
      stepByStep: true,
    })
  })

  it("clamps temperature to [0, 2] with 3-decimal rounding", () => {
    expect(parseSupervisorDecision('{"temperature": 9}')).toEqual({ temperature: 2 })
    expect(parseSupervisorDecision('{"temperature": -1}')).toEqual({ temperature: 0 })
    expect(parseSupervisorDecision('{"temperature": 0.123456}')).toEqual({ temperature: 0.123 })
  })

  it("clamps maxToolCalls to [1, 64] and rounds", () => {
    expect(parseSupervisorDecision('{"maxToolCalls": 0}')).toEqual({ maxToolCalls: 1 })
    expect(parseSupervisorDecision('{"maxToolCalls": -9}')).toEqual({ maxToolCalls: 1 })
    expect(parseSupervisorDecision('{"maxToolCalls": 999}')).toEqual({ maxToolCalls: 64 })
    expect(parseSupervisorDecision('{"maxToolCalls": 12.7}')).toEqual({ maxToolCalls: 13 })
  })

  it("accepts boolean knobs only when actually booleans", () => {
    expect(
      parseSupervisorDecision('{"webSearchFirst": "yes", "clarificationRequired": true, "stepByStep": false}'),
    ).toEqual({ clarificationRequired: true, stepByStep: false })
  })

  it("keeps a bounded reason string", () => {
    const decision = parseSupervisorDecision(JSON.stringify({ temperature: 0.5, reason: "x".repeat(1_000) }))
    expect(decision?.reason).toHaveLength(300)
  })

  it("returns null for garbage, arrays, and objects with no recognized keys", () => {
    expect(parseSupervisorDecision("not json at all")).toBeNull()
    expect(parseSupervisorDecision('["temperature"]')).toBeNull()
    expect(parseSupervisorDecision("{}")).toBeNull()
    expect(parseSupervisorDecision('{"foo": 1, "temperature": "hot"}')).toBeNull()
    expect(parseSupervisorDecision("")).toBeNull()
  })
})

describe("requestSupervisorDecision", () => {
  afterEach(() => resetBudget())
  it("does nothing when the supervisor is unconfigured", async () => {
    const createProvider = vi.fn()
    const out = await requestSupervisorDecision({
      supervisor: { ...configured, provider: "" },
      mistakes: [],
      currentAdjustments: {},
      createProvider,
    })
    expect(out).toBeNull()
    expect(createProvider).not.toHaveBeenCalled()
  })

  it("returns null when the provider id is unknown to the registry", async () => {
    const out = await requestSupervisorDecision({
      supervisor: { ...configured, provider: "definitely-not-a-provider" },
      mistakes: [],
      currentAdjustments: {},
      createProvider: () => undefined,
    })
    expect(out).toBeNull()
  })

  it("sends the mistake log, fills provider defaults, and parses the reply", async () => {
    const chat = vi.fn(async (): Promise<AssistantMessage> =>
      textMessage('```json\n{"temperature":0.05,"maxToolCalls":4}\n```'),
    )
    let seenOptions: ProviderOptions | undefined
    let seenInput: { system?: string; messages: Array<{ role: string; content: string | null }> } | undefined
    const fake: Provider = {
      id: "fake",
      chat: async (input) => {
        seenInput = input
        return chat()
      },
    }
    const mistakes = Array.from({ length: SUPERVISOR_MAX_HISTORY + 5 }, (_, i) => ({
      type: "tool_error",
      severity: 5,
      description: `mistake ${i} ${"y".repeat(500)}`,
      resolved: false,
      timestamp: 1_700_000_000_000 + i,
    }))
    const out = await requestSupervisorDecision({
      supervisor: configured,
      mistakes,
      currentAdjustments: { temperature: 0.2 },
      createProvider: (providerId, options) => {
        expect(providerId).toBe("nvidia")
        seenOptions = options
        return fake
      },
    })
    expect(out).toEqual({ temperature: 0.05, maxToolCalls: 4 })
    expect(chat).toHaveBeenCalledTimes(1)
    // Empty baseUrl falls back to the provider's known default, and an
    // empty key stays undefined (never sent as "").
    expect(seenOptions?.baseUrl).toBe("https://integrate.api.nvidia.com")
    expect(seenOptions?.model).toBe("judge-model")
    expect(seenOptions?.apiKey).toBeUndefined()
    expect(seenOptions?.timeoutMs).toBe(15_000)
    expect(seenInput?.system).toContain("penalty")
    const payload = JSON.parse(seenInput?.messages[0]?.content ?? "{}") as {
      recentMistakes: Array<{ description: string }>
      currentAdjustments: Record<string, number>
    }
    // Payload is bounded: at most SUPERVISOR_MAX_HISTORY entries, each
    // description capped at 200 chars.
    expect(payload.recentMistakes).toHaveLength(SUPERVISOR_MAX_HISTORY)
    expect(payload.recentMistakes.every((m) => m.description.length <= 200)).toBe(true)
    expect(payload.currentAdjustments).toEqual({ temperature: 0.2 })
  })

  it("charges its model call to the rollout budget", async () => {
    // The supervisor's provider call sits OUTSIDE the turn loop, so the loop's
    // usage recording never sees it. Unrecorded, a token cap the user set
    // silently ignored every decision the supervisor made on their dime.
    const reply = '{"temperature":0.4}'
    const sent: string[] = []
    const fake: Provider = {
      id: "fake",
      chat: async (input) => {
        sent.push((input.system ?? "") + (input.messages[0]?.content ?? ""))
        return textMessage(reply)
      },
    }
    // configure() zeroes the accumulator, so this doubles as the reset.
    getRolloutBudget().configure({ samplingTokenWeight: 1, maxBudget: 1_000_000, reminderInterval: 1_000 })
    expect(getRolloutBudget().getUsed()).toBe(0)

    const out = await requestSupervisorDecision({
      supervisor: configured,
      mistakes: [{ type: "tool_error", severity: 3, description: "sloppy", resolved: false, timestamp: 1 }],
      currentAdjustments: { temperature: 0.2 },
      createProvider: () => fake,
    })

    expect(out).toEqual({ temperature: 0.4 })
    // BOTH sides charged (#64): a penalty round is input-heavy — the whole
    // mistake log plus the system prompt goes out on every decision.
    expect(getRolloutBudget().getUsed()).toBe(estimateTokens(sent[0] ?? "") + estimateTokens(reply))
    expect(getRolloutBudget().getUsed()).toBeGreaterThan(0)
  })

  it("passes an abort signal and an explicit baseUrl through untouched", async () => {
    let seenSignal: AbortSignal | undefined
    const fake: Provider = {
      id: "fake",
      chat: async (input) => {
        seenSignal = input.signal
        return textMessage('{"temperature": 0.7}')
      },
    }
    const controller = new AbortController()
    const out = await requestSupervisorDecision({
      supervisor: { ...configured, baseUrl: "http://127.0.0.1:9999/v1" },
      mistakes: [{ type: "loop", severity: 3, description: "spin", resolved: false, timestamp: 1 }],
      currentAdjustments: {},
      signal: controller.signal,
      createProvider: (_id, options) => {
        expect(options.baseUrl).toBe("http://127.0.0.1:9999/v1")
        return fake
      },
    })
    expect(out).toEqual({ temperature: 0.7 })
    expect(seenSignal).toBeDefined()
  })

  it("fails open to null when the backend chat rejects", async () => {
    const fake: Provider = {
      id: "fake",
      chat: async () => {
        throw new Error("backend down")
      },
    }
    const out = await requestSupervisorDecision({
      supervisor: configured,
      mistakes: [{ type: "loop", severity: 3, description: "spin", resolved: false, timestamp: 1 }],
      currentAdjustments: {},
      createProvider: () => fake,
    })
    expect(out).toBeNull()
  })

  it("fails open to null when the reply is not a decision", async () => {
    const fake: Provider = {
      id: "fake",
      chat: async () => textMessage("I think temperature should maybe go down."),
    }
    const out = await requestSupervisorDecision({
      supervisor: configured,
      mistakes: [{ type: "loop", severity: 3, description: "spin", resolved: false, timestamp: 1 }],
      currentAdjustments: {},
      createProvider: () => fake,
    })
    expect(out).toBeNull()
  })
})
