/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  DEFAULT_DEVELOPER_MODE_CONFIG,
  DeveloperModeEngine,
  type DeveloperModeConfig,
  type MistakeRecord,
} from "./index.js"
import type { Tool } from "../tools/index.js"

let tmp = ""

const makeEngine = (config: Partial<DeveloperModeConfig> = {}): DeveloperModeEngine =>
  new DeveloperModeEngine(tmp, config)

const devmodeDir = (): string => path.join(tmp, "skt", "12-control", "devmode")

const mistakeLog = (): string => path.join(devmodeDir(), "mistakes.json")

const recordMistake = (engine: DeveloperModeEngine, severity: 1 | 2 | 3 | 4 | 5): void => {
  engine.recordMistake({
    type: "tool_error",
    description: `severity ${severity} failure`,
    severity,
    context: {},
  })
}

const fakeTool = (name: string): Tool => ({
  definition: { name, description: "", parameters: { type: "object", properties: {}, required: [] }, timeoutMs: 5_000 },
  execute: async () => ({ content: [], isError: false }),
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-devmode-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("DeveloperModeEngine construction", () => {
  it("applies defaults and creates the devmode state directory under cwd", () => {
    const engine = makeEngine()
    expect(engine.config.enabled).toBe(false)
    expect(engine.config.controlMode).toBe("general")
    expect(engine.config.penaltyLevel).toBe(1)
    expect(engine.config.maxSubagents).toBe(3)
    expect(engine.config.cotChain).toEqual(DEFAULT_DEVELOPER_MODE_CONFIG.cotChain)
    expect(fs.existsSync(devmodeDir())).toBe(true)
  })

  it("merges a partial config over the defaults", () => {
    const engine = makeEngine({ enabled: true, controlMode: "accurate", maxSubagents: 5 })
    expect(engine.isEnabled()).toBe(true)
    expect(engine.getControlMode()).toBe("accurate")
    expect(engine.config.maxSubagents).toBe(5)
    expect(engine.config.penaltyLevel).toBe(1)
    expect(engine.getPenaltyLevel()).toBe(1)
    expect(engine.isGateEnabled()).toBe(false)
    expect(engine.isSotaEnabled()).toBe(false)
  })

  it("decodes a pre-serialized cotChain JSON string", () => {
    const engine = makeEngine({
      cotChain: JSON.stringify({ enabled: true, branchFactor: 7 }),
    } as unknown as Partial<DeveloperModeConfig>)
    const chain = engine.getCotChainConfig()
    expect(chain.enabled).toBe(true)
    expect(chain.branchFactor).toBe(7)
    expect(chain.maxDepth).toBe(5) // untouched fields keep defaults
    expect(engine.isCotChainEnabled()).toBe(true)
  })

  it("falls back to the default cotChain when the serialized string is not JSON", () => {
    const engine = makeEngine({ cotChain: "{not json" } as unknown as Partial<DeveloperModeConfig>)
    expect(engine.getCotChainConfig()).toEqual(DEFAULT_DEVELOPER_MODE_CONFIG.cotChain)
  })
})

describe("DeveloperModeEngine cot/sota toggles", () => {
  it("toggleCotChain(true) also enables sota; toggling off leaves sota on", () => {
    const engine = makeEngine()
    engine.toggleCotChain(true)
    expect(engine.isCotChainEnabled()).toBe(true)
    expect(engine.isSotaEnabled()).toBe(true)
    engine.toggleCotChain(false)
    expect(engine.isCotChainEnabled()).toBe(false)
    expect(engine.isSotaEnabled()).toBe(true)
  })

  it("toggleSota flips the flag in both directions", () => {
    const engine = makeEngine()
    engine.toggleSota(true)
    expect(engine.isSotaEnabled()).toBe(true)
    engine.toggleSota(false)
    expect(engine.isSotaEnabled()).toBe(false)
  })

  it("updateCotConfig patches only the given fields and getCotChainConfig returns a copy", () => {
    const engine = makeEngine()
    engine.updateCotConfig({ maxDepth: 2, verifier: "independent" })
    const chain = engine.getCotChainConfig()
    expect(chain.maxDepth).toBe(2)
    expect(chain.verifier).toBe("independent")
    expect(chain.branchFactor).toBe(3)
    // Mutating the returned copy must not leak into the engine config.
    chain.enabled = true
    expect(engine.isCotChainEnabled()).toBe(false)
  })
})

describe("DeveloperModeEngine mistakes and penalties", () => {
  it("severity 1 records a mistake with an empty penalty adjustment", () => {
    const engine = makeEngine({ enabled: true })
    recordMistake(engine, 1)
    expect(engine.getUnresolvedMistakeCount()).toBe(1)
    expect(engine.getActivePenaltyCount()).toBe(1)
    expect(engine.getActivePenaltyAdjustments()).toEqual({})
  })

  it("severity 3 in general mode lowers temperature and caps tool calls", () => {
    const engine = makeEngine({ enabled: true })
    recordMistake(engine, 3)
    expect(engine.getActivePenaltyAdjustments()).toEqual({ temperature: 0.1, maxToolCalls: 7 })
  })

  it("severity 5 forces web search, clarification and step-by-step", () => {
    const engine = makeEngine({ enabled: true })
    recordMistake(engine, 5)
    expect(engine.getActivePenaltyAdjustments()).toEqual({
      temperature: 0.1,
      maxToolCalls: 5,
      webSearchFirst: true,
      clarificationRequired: true,
      stepByStep: true,
    })
  })

  it("accurate mode applies a smaller temperature penalty", () => {
    const engine = makeEngine({ enabled: true, controlMode: "accurate" })
    recordMistake(engine, 2)
    expect(engine.getActivePenaltyAdjustments()).toEqual({ temperature: 0.05 })
  })

  it("observeMistakes: false records the mistake but applies no penalty", () => {
    const engine = makeEngine({ enabled: true, observeMistakes: false })
    recordMistake(engine, 4)
    expect(engine.getUnresolvedMistakeCount()).toBe(1)
    expect(engine.getActivePenaltyCount()).toBe(0)
    expect(engine.getActivePenaltyAdjustments()).toEqual({})
  })

  it("merges penalties: temperature accumulates, maxToolCalls takes the minimum", () => {
    const engine = makeEngine({ enabled: true })
    recordMistake(engine, 2)
    recordMistake(engine, 2)
    expect(engine.getActivePenaltyAdjustments()).toEqual({ temperature: 0.2 })
    recordMistake(engine, 3)
    // Escalation is cumulative (>= chain in applyPenaltyFromMistake): L3
    // adds its tool cap on top of the L2 temperature damp, so temp is 0.3.
    expect(engine.getActivePenaltyAdjustments()).toEqual({ temperature: 0.3, maxToolCalls: 7 })
    recordMistake(engine, 5) // fourth +0.1 damp
    const merged = engine.getActivePenaltyAdjustments()
    expect(merged.temperature).toBeCloseTo(0.4)
    expect(merged.maxToolCalls).toBe(5) // the stricter cap wins
    expect(merged.webSearchFirst).toBe(true)
  })

  it("resolveMistake flips resolved via the persisted log and survives a restart", () => {
    const engine = makeEngine({ enabled: true })
    recordMistake(engine, 2)
    const log = JSON.parse(fs.readFileSync(mistakeLog(), "utf8")) as Array<MistakeRecord>
    expect(log).toHaveLength(1)
    expect(engine.resolveMistake(log[0].id)).toBe(true)
    expect(engine.resolveMistake("mistake_nope")).toBe(false)
    expect(engine.getUnresolvedMistakeCount()).toBe(0)

    const restarted = makeEngine({ enabled: true })
    expect(restarted.getUnresolvedMistakeCount()).toBe(0)
    expect(restarted.getActivePenaltyCount()).toBe(1) // penalties are never dropped
  })

  it("restarts reload unresolved mistakes, penalties and subagents from disk", () => {
    const engine = makeEngine({ enabled: true })
    recordMistake(engine, 2)
    engine.startSubagent("worker", "do the thing")

    const restarted = makeEngine({ enabled: true })
    expect(restarted.getUnresolvedMistakeCount()).toBe(1)
    expect(restarted.getActivePenaltyCount()).toBe(1)
    expect(restarted.getAllSubagents()).toHaveLength(1)
    expect(restarted.getAllSubagents()[0].name).toBe("worker")
  })

  it("tolerates corrupt persisted logs instead of throwing", () => {
    fs.mkdirSync(devmodeDir(), { recursive: true })
    fs.writeFileSync(path.join(devmodeDir(), "mistakes.json"), "{broken", "utf8")
    fs.writeFileSync(path.join(devmodeDir(), "penalties.json"), "[nope", "utf8")
    fs.writeFileSync(path.join(devmodeDir(), "subagents.json"), "not json", "utf8")
    const engine = makeEngine()
    expect(engine.getUnresolvedMistakeCount()).toBe(0)
    expect(engine.getActivePenaltyCount()).toBe(0)
    expect(engine.getAllSubagents()).toEqual([])
  })
})

describe("DeveloperModeEngine clarification", () => {
  it("needsClarification is gated by enabled and clarificationRequired", () => {
    expect(makeEngine().needsClarification("build an app")).toBe(false)
    expect(makeEngine({ enabled: true, clarificationRequired: false }).needsClarification("build an app")).toBe(false)
    expect(makeEngine({ enabled: true }).needsClarification("build an app")).toBe(true)
  })

  it("flags a vague request and lets a detailed one through", () => {
    const engine = makeEngine({ enabled: true })
    expect(engine.needsClarification("build me an app")).toBe(true)
    expect(engine.needsClarification("build me an app using react and typescript")).toBe(false)
  })

  it("lets long prompts through even when they match a vague pattern", () => {
    const engine = makeEngine({ enabled: true })
    expect(
      engine.needsClarification("build me an app as soon as possible because we really really want this thing done"),
    ).toBe(false)
  })

  it("does not flag a prompt with no vague pattern", () => {
    const engine = makeEngine({ enabled: true })
    expect(engine.needsClarification("describe the algorithm")).toBe(false)
  })

  it("analyzePrompt is empty when the gate is off", () => {
    expect(makeEngine().analyzePrompt("make me a website")).toEqual([])
    expect(makeEngine({ enabled: true, clarificationRequired: false }).analyzePrompt("make me a website")).toEqual([])
  })

  it("analyzePrompt asks type + stack for a website request", () => {
    const questions = makeEngine({ enabled: true }).analyzePrompt("make me a website")
    expect(questions).toHaveLength(2)
    expect(questions[0].id).toContain("_type")
    expect(questions[0].options).toHaveLength(6)
    expect(questions[1].id).toContain("_stack")
    expect(questions[1].options).toHaveLength(5)
    expect(questions[0].resolved).toBe(false)
    expect(questions[0].context).toBe("make me a website")
  })

  it("analyzePrompt picks the platform question for an app request", () => {
    const questions = makeEngine({ enabled: true }).analyzePrompt("build a mobile app")
    expect(questions).toHaveLength(1)
    expect(questions[0].id).toContain("_platform")
    expect(questions[0].options).toHaveLength(4)
  })

  it("analyzePrompt picks the backend question for an api request", () => {
    const questions = makeEngine({ enabled: true }).analyzePrompt("create an api backend")
    expect(questions).toHaveLength(1)
    expect(questions[0].id).toContain("_api_stack")
    expect(questions[0].options).toHaveLength(5)
  })

  it("analyzePrompt picks the runtime question for a bot request", () => {
    const questions = makeEngine({ enabled: true }).analyzePrompt("write a telegram bot script")
    expect(questions).toHaveLength(1)
    expect(questions[0].id).toContain("_bot_platform")
    expect(questions[0].options).toHaveLength(4)
  })

  it("analyzePrompt falls back to a scope question", () => {
    const questions = makeEngine({ enabled: true }).analyzePrompt("do the thing now")
    expect(questions).toHaveLength(1)
    expect(questions[0].id).toContain("_scope")
    expect(questions[0].options).toHaveLength(4)
  })

  it("analyzePrompt caps output at three questions", () => {
    const questions = makeEngine({ enabled: true }).analyzePrompt("build a website with an api and a bot for me")
    expect(questions).toHaveLength(3)
    expect(questions[0].id).toContain("_type")
    expect(questions[1].id).toContain("_stack")
    expect(questions[2].id).toContain("_api_stack")
  })

  it("createClarification/resolveClarification track pending questions", () => {
    const engine = makeEngine({ enabled: true })
    const entry = engine.createClarification("Which target?", "context", [{ label: "A", value: "a" }])
    expect(entry.resolved).toBe(false)
    expect(engine.getPendingClarifications()).toHaveLength(1)
    expect(engine.resolveClarification(entry.id, "A")).toBe(true)
    expect(engine.resolveClarification("clarify_missing", "x")).toBe(false)
    expect(engine.getPendingClarifications()).toEqual([])
    expect(entry.answer).toBe("A")
  })
})

describe("DeveloperModeEngine step plans", () => {
  it("createStepPlan seeds a single pending step", () => {
    const engine = makeEngine()
    const plan = engine.createStepPlan("Ship it")
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].description).toBe("Ship it")
    expect(plan.steps[0].status).toBe("pending")
    expect(plan.currentStepIndex).toBe(0)
    expect(plan.completed).toBe(false)
    expect(plan.steps[0].id.startsWith("plan_")).toBe(true)
    expect(plan.steps[0].id.endsWith("_step_1")).toBe(true)
  })

  it("expandStepPlan replaces the steps and preserves dependencies", () => {
    const engine = makeEngine()
    const plan = engine.createStepPlan("Ship it")
    const planId = plan.steps[0].id.replace("_step_1", "")
    const expanded = engine.expandStepPlan(planId, [
      { description: "first", dependsOn: ["init"] },
      { description: "second" },
    ])
    expect(expanded?.steps.map((s) => s.id)).toEqual([`${planId}_step_1`, `${planId}_step_2`])
    expect(expanded?.steps[0].dependsOn).toEqual(["init"])
    expect(expanded?.steps[1].dependsOn).toBeUndefined()
    expect(expanded?.currentStepIndex).toBe(0)
    expect(engine.expandStepPlan("plan_missing", [{ description: "x" }])).toBeUndefined()
  })

  it("advance/fail/complete drive a two-step plan to completion", () => {
    const engine = makeEngine()
    const plan = engine.createStepPlan("Ship it")
    const planId = plan.steps[0].id.replace("_step_1", "")
    const expanded = engine.expandStepPlan(planId, [{ description: "first" }, { description: "second" }])
    expect(expanded).toBeDefined()
    expect(engine.getStepPlan("plan_missing")).toBeUndefined()

    const advanced = engine.advanceStepPlan(planId)
    expect(advanced?.step.status).toBe("in_progress")
    expect(advanced?.plan).toBe(plan)
    // Advancing again keeps the same in-progress step.
    expect(engine.advanceStepPlan(planId)?.step.status).toBe("in_progress")

    expect(engine.failStep("plan_missing", "s", "err")).toBe(false)
    expect(engine.failStep(planId, "missing_step", "err")).toBe(false)
    expect(engine.completeStep("plan_missing", "s", "ok")).toBe(false)
    expect(engine.completeStep(planId, "missing_step", "ok")).toBe(false)

    const firstStep = expanded?.steps[0]
    expect(firstStep).toBeDefined()
    expect(engine.failStep(planId, firstStep?.id ?? "", "boom")).toBe(true)
    expect(engine.getStepPlan(planId)?.steps[0].status).toBe("failed")
    expect(engine.getStepPlan(planId)?.steps[0].result).toBe("boom")

    expect(engine.completeStep(planId, firstStep?.id ?? "", "done")).toBe(true)
    expect(engine.getStepPlan(planId)?.completed).toBe(false) // one step left
    expect(engine.getStepPlan(planId)?.currentStepIndex).toBe(1)

    const secondStep = expanded?.steps[1]
    expect(engine.advanceStepPlan(planId)?.step.id).toBe(secondStep?.id)
    expect(engine.completeStep(planId, secondStep?.id ?? "", "ok")).toBe(true)
    expect(engine.getStepPlan(planId)?.completed).toBe(true)
    expect(engine.advanceStepPlan(planId)).toBeUndefined()
  })
})

describe("DeveloperModeEngine subagents", () => {
  it("tracks the lifecycle start → running → completed", () => {
    const engine = makeEngine()
    const task = engine.startSubagent("reviewer", "review this", "parent-1")
    expect(task.status).toBe("pending")
    expect(task.parentId).toBe("parent-1")
    expect(engine.getActiveSubagents().map((t) => t.id)).toContain(task.id)

    expect(engine.updateSubagent(task.id, { status: "running" })).toBe(true)
    expect(engine.getSubagent(task.id)?.status).toBe("running")
    expect(typeof engine.getSubagent(task.id)?.startedAt).toBe("number")

    expect(engine.completeSubagent(task.id, "all good")).toBe(true)
    const done = engine.getSubagent(task.id)
    expect(done?.status).toBe("completed")
    expect(done?.result).toBe("all good")
    expect(typeof done?.finishedAt).toBe("number")
    expect(engine.getActiveSubagents()).toEqual([])
    expect(engine.getAllSubagents()).toHaveLength(1)
  })

  it("failSubagent/cancelSubagent terminal states and unknown ids return false", () => {
    const engine = makeEngine()
    const failing = engine.startSubagent("a", "p")
    const cancelled = engine.startSubagent("b", "p")
    expect(engine.failSubagent(failing.id, "kaput")).toBe(true)
    expect(engine.getSubagent(failing.id)?.error).toBe("kaput")
    expect(engine.cancelSubagent(cancelled.id)).toBe(true)
    expect(engine.getSubagent(cancelled.id)?.status).toBe("cancelled")
    expect(engine.failSubagent("sub_missing", "x")).toBe(false)
    expect(engine.updateSubagent("sub_missing", { status: "running" })).toBe(false)
    expect(engine.cancelSubagent("sub_missing")).toBe(false)
  })
})

describe("DeveloperModeEngine cross monitoring", () => {
  it("pairs agents that share a parent and reports failure as blocked", () => {
    const engine = makeEngine()
    const a = engine.startSubagent("a", "p", "shared")
    const b = engine.startSubagent("b", "p", "shared")
    engine.failSubagent(a.id, "boom")
    engine.updateSubagent(b.id, { status: "running" })
    const pairs = engine.crossMonitorSubagents()
    expect(pairs).toHaveLength(1)
    expect(pairs[0].agentA.id).toBe(a.id)
    expect(pairs[0].status).toBe("blocked")
  })

  it("reports both_done and parallel_active for matching terminal states", () => {
    const engine = makeEngine()
    const a = engine.startSubagent("a", "p", "shared")
    const b = engine.startSubagent("b", "p", "shared")
    engine.completeSubagent(a.id, "1")
    engine.completeSubagent(b.id, "2")
    expect(engine.crossMonitorSubagents()[0].status).toBe("both_done")

    const c = engine.startSubagent("c", "p", "other")
    const d = engine.startSubagent("d", "p", "other")
    engine.updateSubagent(c.id, { status: "running" })
    engine.updateSubagent(d.id, { status: "running" })
    const pairs = engine.crossMonitorSubagents()
    const pair = pairs.find((p) => p.agentA.id === c.id && p.agentB.id === d.id)
    expect(pair?.status).toBe("parallel_active")
  })

  it("pairs agents through peerId even across different parents", () => {
    const engine = makeEngine()
    const a = engine.startSubagent("a", "p", "parent-a")
    engine.startSubagent("b", "p", "parent-b", a.id)
    const pairs = engine.crossMonitorSubagents()
    expect(pairs).toHaveLength(1)
    expect(pairs[0].status).toBe("independent")
  })

  it("does not pair agents with different parents and no peer link", () => {
    const engine = makeEngine()
    engine.startSubagent("a", "p", "parent-a")
    engine.startSubagent("b", "p", "parent-b")
    expect(engine.crossMonitorSubagents()).toEqual([])
  })
})

describe("DeveloperModeEngine rag cache and workflows", () => {
  it("ragEnabled: false makes the cache inert", () => {
    const engine = makeEngine({ ragEnabled: false })
    engine.addToRagCache("k", "text", [1, 0])
    expect(engine.getFromRagCache("k")).toBeUndefined()
    expect(engine.searchRagCache([1, 0])).toEqual([])
  })

  it("searchRagCache ranks by cosine similarity and honors topK", () => {
    const engine = makeEngine()
    engine.addToRagCache("exact", "same", [1, 0])
    engine.addToRagCache("none", "different", [0, 1])
    engine.addToRagCache("partial", "near", [0.6, 0.8])
    engine.addToRagCache("bad-dims", "wrong shape", [1, 0, 0])

    const all = engine.searchRagCache([1, 0])
    expect(all.map((r) => r.key)).toEqual(["exact", "partial", "none", "bad-dims"])
    expect(all[0].score).toBe(1)
    expect(all[1].score).toBeCloseTo(0.6)
    expect(all[3].score).toBe(0)
    expect(engine.searchRagCache([1, 0], 1)).toHaveLength(1)
    expect(engine.searchRagCache([])).toHaveLength(4)
    expect(engine.searchRagCache([])[0].score).toBe(0)
  })

  it("workflows register only when enabled and are listed by name", () => {
    const engine = makeEngine()
    engine.registerWorkflow("release", [{ step: 1 }])
    expect(engine.getWorkflow("release")).toEqual([{ step: 1 }])
    expect(engine.getWorkflow("missing")).toBeUndefined()
    expect(engine.listWorkflows()).toEqual(["release"])

    const disabled = makeEngine({ workflowsEnabled: false })
    disabled.registerWorkflow("release", [{ step: 1 }])
    expect(disabled.listWorkflows()).toEqual([])
    expect(disabled.getWorkflow("release")).toBeUndefined()
  })
})

describe("DeveloperModeEngine prompt suffix and tool ordering", () => {
  it("returns an empty suffix while disabled", () => {
    expect(makeEngine().getSystemPromptSuffix()).toBe("")
  })

  it("renders every section for the default enabled config", () => {
    const suffix = makeEngine({ enabled: true }).getSystemPromptSuffix()
    expect(suffix).toContain("=== DEVELOPER MODE ACTIVE ===")
    expect(suffix).toContain("Control Mode: GENERAL")
    expect(suffix).toContain("Penalty Level: 1/5")
    expect(suffix).toContain("CLARIFICATION PROTOCOL:")
    expect(suffix).toContain("STEP-BY-STEP EXECUTION:")
    expect(suffix).toContain("MISTAKE OBSERVATION:")
    expect(suffix).toContain("You may spawn up to 3 parallel subagents.")
    expect(suffix).toContain("web_fetch is DISABLED by default for safety.")
    expect(suffix).toContain("WORKFLOWS:")
    expect(suffix).toContain("=== END DEVELOPER MODE ===")
  })

  it("omits sections whose flags are off", () => {
    const engine = makeEngine({
      enabled: true,
      controlMode: "accurate",
      penaltyLevel: 4,
      clarificationRequired: false,
      stepByStep: false,
      observeMistakes: false,
      parallelSubagents: false,
      webFetchEnabled: true,
      workflowsEnabled: false,
    })
    const suffix = engine.getSystemPromptSuffix()
    expect(suffix).toContain("Control Mode: ACCURATE")
    expect(suffix).toContain("Penalty Level: 4/5")
    expect(suffix).not.toContain("CLARIFICATION PROTOCOL:")
    expect(suffix).not.toContain("STEP-BY-STEP EXECUTION:")
    expect(suffix).not.toContain("MISTAKE OBSERVATION:")
    expect(suffix).not.toContain("parallel subagents")
    expect(suffix).not.toContain("WEB FETCH:")
    expect(suffix).not.toContain("WORKFLOWS:")
  })

  it("getToolPriority follows the documented order and respects feature flags", () => {
    const engine = makeEngine()
    expect(engine.getToolPriority()).toEqual([
      "web_search",
      "web_fetch",
      "rag_query",
      "rag_store",
      "todo",
      "skill__",
      "mcp__",
    ])
    const bare = makeEngine({
      webSearchFirst: false,
      webBrowseEnabled: false,
      ragEnabled: false,
      todoEnabled: false,
      skillsEnabled: false,
      mcpServersEnabled: false,
    })
    expect(bare.getToolPriority()).toEqual([])
  })

  it("reorderTools returns the input untouched while disabled", () => {
    const engine = makeEngine({ enabled: false })
    const tools = [fakeTool("read"), fakeTool("web_search")]
    expect(engine.reorderTools(tools)).toBe(tools)
  })

  it("reorderTools hoists priority-prefixed tools while keeping relative order", () => {
    const engine = makeEngine({ enabled: true })
    const tools = [
      fakeTool("read"),
      fakeTool("web_search"),
      fakeTool("exec"),
      fakeTool("mcp__github"),
      fakeTool("todo"),
      fakeTool("skill__pdf"),
    ]
    expect(engine.reorderTools(tools).map((t) => t.definition.name)).toEqual([
      "web_search",
      "mcp__github",
      "todo",
      "skill__pdf",
      "read",
      "exec",
    ])
  })
})

describe("DeveloperModeEngine config overrides", () => {
  it("general mode defaults", () => {
    const overrides = makeEngine().getConfigOverrides()
    expect(overrides).toEqual({
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 4096,
      sotaEnabled: false,
      gateEnabled: false,
      enabled: false,
    })
  })

  it("accurate mode tightens sampling", () => {
    const overrides = makeEngine({ controlMode: "accurate", enabled: true }).getConfigOverrides()
    expect(overrides.temperature).toBe(0)
    expect(overrides.topP).toBe(0.8)
    expect(overrides.maxTokens).toBe(8192)
  })

  it("penalty adjustments override the mode baseline", () => {
    const engine = makeEngine({ enabled: true })
    recordMistake(engine, 4)
    const overrides = engine.getConfigOverrides()
    expect(overrides.temperature).toBe(0.1)
    expect(overrides.maxToolCalls).toBe(6)
    expect(overrides.webSearchFirst).toBe(true)
    expect(overrides.enabled).toBe(true)
  })

  it("a severity-5 penalty forces clarification and step-by-step overrides", () => {
    const engine = makeEngine({ enabled: true, controlMode: "accurate" })
    recordMistake(engine, 5)
    const overrides = engine.getConfigOverrides()
    expect(overrides.maxToolCalls).toBe(5)
    expect(overrides.clarificationRequired).toBe(true)
    expect(overrides.stepByStep).toBe(true)
  })
})
