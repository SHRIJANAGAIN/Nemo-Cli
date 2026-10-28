/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Controller state machine coverage — state.ts, router.ts, roles.ts,
 * reviewer.ts, controller.ts and executor.ts were 0% before this suite.
 *
 * Pure logic only: no provider, no network, no filesystem. The executor is
 * exercised with a fake in-memory tool plus the real permission gate.
 */

import { afterEach, describe, expect, it } from "vitest"
import { createInitialContext, createInitialControllerState, type ControllerState, type RoleContext } from "./state.js"
import { route, getRolePrompt, getRoleSystemPrompt } from "./router.js"
import { ROLES } from "./roles.js"
import { Reviewer } from "./reviewer.js"
import { AgentController } from "./controller.js"
import { Executor } from "./executor.js"
import type { Tool } from "../tools/types.js"
import { Session } from "../session/session.js"
import type { Provider } from "../../../../packages/provider/src/index.js"
import {
  addSessionPermissionRule,
  clearSessionPermissionRules,
} from "../../../../packages/protocol/src/permission-rules.js"

function stateWith(overrides: Partial<RoleContext>): ControllerState {
  const state = createInitialControllerState("goal")
  Object.assign(state.context, overrides)
  return state
}

/* ─────────────────────────── state.ts ─────────────────────────── */

describe("createInitialContext / createInitialControllerState", () => {
  it("starts in UNDERSTAND with an analyzer role and empty collections", () => {
    const ctx = createInitialContext("ship the feature")
    expect(ctx.goal).toBe("ship the feature")
    expect(ctx.role).toBe("analyzer")
    expect(ctx.currentState).toBe("UNDERSTAND")
    expect(ctx.attempt).toBe(0)
    expect(ctx.strategyChanges).toBe(0)
    expect(ctx.requirements).toEqual([])
    expect(ctx.failedSteps).toEqual([])
    expect(ctx.tests).toEqual([])
    expect(ctx.openQuestions).toEqual([])
  })

  it("wires a fresh state around that context with an unused budget", () => {
    const state = createInitialControllerState("g")
    expect(state.state).toBe("START")
    expect(state.role).toBe("analyzer")
    expect(state.searchBudgetUsed).toBe(0)
    expect(state.searchBudgetLimit).toBe(10000)
    expect(state.repetitionCount).toBe(0)
    expect(state.progressHistory).toEqual([])
    expect(state.context).not.toBe(createInitialControllerState("g").context)
  })
})

/* ─────────────────────────── router.ts ─────────────────────────── */

describe("route", () => {
  it("treats DONE and ESCALATE as terminal (no further transitions)", () => {
    expect(route(stateWith({ currentState: "DONE" }))).toEqual({
      nextState: "DONE",
      nextRole: "analyzer",
    })
    expect(route(stateWith({ currentState: "ESCALATE" }))).toEqual({
      nextState: "ESCALATE",
      nextRole: "analyzer",
    })
  })

  it("UNDERSTAND: open questions route to RESEARCH", () => {
    const decision = route(stateWith({ currentState: "UNDERSTAND", openQuestions: ["why?"] }))
    expect(decision).toEqual({ nextState: "RESEARCH", nextRole: "researcher" })
  })

  it("UNDERSTAND: repetition guard escalates even with open questions", () => {
    const decision = route(stateWith({ currentState: "UNDERSTAND", openQuestions: ["why?"], attempt: 3 }))
    expect(decision).toEqual({ nextState: "ESCALATE", nextRole: "escalator" })
  })

  it("UNDERSTAND: strategy-change guard also escalates", () => {
    const decision = route(stateWith({ currentState: "UNDERSTAND", strategyChanges: 2 }))
    expect(decision.nextState).toBe("ESCALATE")
  })

  it("UNDERSTAND: no open questions goes straight to PLAN", () => {
    expect(route(stateWith({ currentState: "UNDERSTAND" }))).toEqual({
      nextState: "PLAN",
      nextRole: "planner",
    })
  })

  it("RESEARCH: repeated failures escalate, otherwise continue to PLAN", () => {
    const failing = route(stateWith({ currentState: "RESEARCH", failedSteps: ["err"], attempt: 3 }))
    expect(failing).toEqual({ nextState: "ESCALATE", nextRole: "escalator" })
    const healthy = route(stateWith({ currentState: "RESEARCH" }))
    expect(healthy).toEqual({ nextState: "PLAN", nextRole: "planner" })
  })

  it("PLAN: guard escalates, otherwise dispatches to implementer", () => {
    const guarded = stateWith({ currentState: "PLAN", attempt: 3 })
    expect(route(guarded)).toEqual({ nextState: "ESCALATE", nextRole: "escalator" })
    expect(route(stateWith({ currentState: "PLAN" }))).toEqual({
      nextState: "EXECUTE",
      nextRole: "implementer",
    })
  })

  it("EXECUTE: failures go to DEBUG, repeated failures escalate, clean run verifies", () => {
    expect(route(stateWith({ currentState: "EXECUTE", failedSteps: ["boom"] }))).toEqual({
      nextState: "DEBUG",
      nextRole: "debugger",
    })
    expect(route(stateWith({ currentState: "EXECUTE", failedSteps: ["boom"], strategyChanges: 2 }))).toEqual({
      nextState: "ESCALATE",
      nextRole: "escalator",
    })
    expect(route(stateWith({ currentState: "EXECUTE" }))).toEqual({
      nextState: "VERIFY",
      nextRole: "reviewer",
    })
  })

  it("DEBUG: retries EXECUTE until the guard trips", () => {
    expect(route(stateWith({ currentState: "DEBUG" }))).toEqual({
      nextState: "EXECUTE",
      nextRole: "implementer",
    })
    expect(route(stateWith({ currentState: "DEBUG", attempt: 3 }))).toEqual({
      nextState: "ESCALATE",
      nextRole: "escalator",
    })
  })

  it("VERIFY: untested requirements route to TEST, full coverage completes", () => {
    expect(route(stateWith({ currentState: "VERIFY", requirements: ["req-1"], tests: [] }))).toEqual({
      nextState: "TEST",
      nextRole: "tester",
    })
    expect(route(stateWith({ currentState: "VERIFY", requirements: ["req-1"], tests: ["covers req-1"] }))).toEqual({
      nextState: "DONE",
      nextRole: "completer",
    })
  })

  it("TEST: failures fall back to DEBUG, clean tests complete", () => {
    expect(route(stateWith({ currentState: "TEST", failedSteps: ["test failed"] }))).toEqual({
      nextState: "DEBUG",
      nextRole: "debugger",
    })
    expect(route(stateWith({ currentState: "TEST" }))).toEqual({
      nextState: "DONE",
      nextRole: "completer",
    })
  })

  it("unknown states fall through to ESCALATE (no silent loop)", () => {
    expect(route(stateWith({ currentState: "START" }))).toEqual({
      nextState: "ESCALATE",
      nextRole: "escalator",
    })
    expect(route(stateWith({ currentState: "FINALIZE" })).nextState).toBe("ESCALATE")
  })
})

describe("role prompt lookup", () => {
  it("returns the role's own prompt and system prompt", () => {
    expect(getRolePrompt("planner")).toBe(ROLES.planner.prompt)
    expect(getRoleSystemPrompt("planner")).toBe(ROLES.planner.systemPrompt)
  })

  it("falls back to the escalator for unknown roles", () => {
    expect(getRolePrompt("no-such-role")).toBe(ROLES.escalator.prompt)
    expect(getRoleSystemPrompt("no-such-role")).toBe(ROLES.escalator.systemPrompt)
  })
})

/* ─────────────────────────── roles.ts ─────────────────────────── */

describe("ROLES", () => {
  it("defines every role the router can emit with non-empty prompts", () => {
    const emitted = [
      "researcher",
      "planner",
      "escalator",
      "implementer",
      "debugger",
      "reviewer",
      "tester",
      "completer",
      "analyzer",
    ]
    for (const role of emitted) {
      expect(ROLES[role], `missing role ${role}`).toBeDefined()
      expect(ROLES[role].name).toBe(role)
      expect(ROLES[role].prompt.length).toBeGreaterThan(0)
      expect(ROLES[role].systemPrompt.length).toBeGreaterThan(0)
    }
  })
})

/* ────────────────────────── reviewer.ts ────────────────────────── */

describe("Reviewer", () => {
  const reviewer = new Reviewer()

  it("reviewRequirements: flags missing requirements", () => {
    const result = reviewer.reviewRequirements(createInitialContext("g"))
    expect(result.passed).toBe(false)
    expect(result.issues).toContain("No requirements defined")
    expect(result.score).toBeLessThan(100)
  })

  it("reviewRequirements: flags requirements without tests and tests without requirements", () => {
    const ctx = createInitialContext("g")
    ctx.requirements = ["req-1", "req-2"]
    ctx.tests = ["covers req-1", "orphan test"]
    const result = reviewer.reviewRequirements(ctx)
    expect(result.passed).toBe(false)
    expect(result.issues.some((i) => i.includes("req-2"))).toBe(true)
    expect(result.issues.some((i) => i.includes("orphan test"))).toBe(true)
  })

  it("reviewRequirements: every requirement tested with mapped tests passes at 100", () => {
    const ctx = createInitialContext("g")
    ctx.requirements = ["req-1"]
    ctx.tests = ["covers req-1"]
    const result = reviewer.reviewRequirements(ctx)
    expect(result).toEqual({ passed: true, score: 100, issues: [], suggestions: [] })
  })

  it("reviewCode: scores down for 'any' and console.log, clean code passes", () => {
    const dirty = reviewer.reviewCode("const x: any = 1; console.log(x)", "ts")
    expect(dirty.passed).toBe(false)
    expect(dirty.score).toBe(70)
    const clean = reviewer.reviewCode("const x: number = 1", "ts")
    expect(clean.passed).toBe(true)
    expect(clean.score).toBe(100)
  })

  it("reviewPlan: rejects empty and duplicate plans, accepts a clean one", () => {
    expect(reviewer.reviewPlan([]).passed).toBe(false)
    const circular = reviewer.reviewPlan(["step a", "step a"])
    expect(circular.passed).toBe(false)
    expect(circular.issues.join(" ")).toContain("circular")
    const good = reviewer.reviewPlan(["step a", "step b", "step c"])
    expect(good).toEqual({ passed: true, score: 100, issues: [], suggestions: [] })
  })
})

/* ───────────────────────── controller.ts ───────────────────────── */

describe("AgentController", () => {
  it("routes the first observation from UNDERSTAND to PLAN", () => {
    const controller = new AgentController("ship it")
    const result = controller.step("analyzed the goal")
    expect(result.state.context.observations).toContain("analyzed the goal")
    expect(result.state.state).toBe("PLAN")
    expect(result.state.role).toBe("planner")
    expect(result.output).toContain("[planner]")
    expect(result.output).toContain(ROLES.planner.prompt)
    expect(result.shouldContinue).toBe(true)
  })

  it("records failures in progressHistory and increments the attempt", () => {
    const controller = new AgentController("g")
    const result = controller.step("bad news", undefined, "boom")
    expect(result.state.context.failedSteps).toContain("boom")
    expect(result.state.progressHistory).toEqual([{ attempt: 0, error: "boom", passed: false }])
    expect(result.state.context.attempt).toBe(1)
  })

  it("records explicit pass results without counting them as failures", () => {
    const controller = new AgentController("g")
    controller.step("all good", true)
    expect(controller.state.context.failedSteps).toEqual([])
    expect(controller.state.progressHistory).toEqual([{ attempt: 0, passed: true }])
    expect(controller.state.context.attempt).toBe(0)
  })

  it("stops when routing reaches ESCALATE", () => {
    const controller = new AgentController("g")
    controller.state.context.attempt = 3
    const result = controller.step("still stuck", undefined, "err")
    expect(result.state.state).toBe("ESCALATE")
    expect(result.shouldContinue).toBe(false)
    expect(result.output).toContain("[escalator]")
  })

  it("stops when routing reaches DONE", () => {
    const controller = new AgentController("g")
    controller.state.context.currentState = "TEST"
    const result = controller.step("tests passed", true)
    expect(result.state.state).toBe("DONE")
    expect(result.shouldContinue).toBe(false)
    expect(result.output).toContain("[completer]")
  })

  it("enforces the search budget (never exceeds the limit)", () => {
    const controller = new AgentController("g")
    expect(controller.useSearchBudget(10000)).toBe(true)
    expect(controller.useSearchBudget(1)).toBe(false)
    expect(controller.state.searchBudgetUsed).toBe(10000)
  })

  it("tracks repetition and strategy-change counters with reset", () => {
    const controller = new AgentController("g")
    controller.incrementRepetition()
    controller.incrementRepetition()
    expect(controller.state.repetitionCount).toBe(2)
    controller.resetRepetition()
    expect(controller.state.repetitionCount).toBe(0)
    controller.incrementStrategyChange()
    expect(controller.state.context.strategyChanges).toBe(1)
  })

  it("collectors append to the context they are named after", () => {
    const controller = new AgentController("g")
    controller.addEvidence("e1")
    controller.addRequirement("r1")
    controller.addAssumption("a1")
    controller.addTest("t1")
    const ctx = controller.getContext()
    expect(ctx.evidence).toEqual(["e1"])
    expect(ctx.requirements).toEqual(["r1"])
    expect(ctx.assumptions).toEqual(["a1"])
    expect(ctx.tests).toEqual(["t1"])
  })
})

/* ───────────────────────── executor.ts ────────────────────────── */

function fakeTool(execute: Tool["execute"]): Tool {
  return {
    definition: {
      name: "write_file",
      description: "test double",
      parameters: { type: "object", properties: {}, required: [] },
      timeoutMs: 10_000,
    },
    execute,
  }
}

function executorWith(tools: Tool[]): Executor {
  return new Executor({
    provider: {} as Provider,
    tools,
    session: new Session(),
  })
}

afterEach(() => {
  clearSessionPermissionRules()
})

describe("Executor", () => {
  it("runs the built tool call and joins text output on success", async () => {
    const executor = executorWith([
      fakeTool(async () => ({ content: [{ type: "text", text: "written" }], isError: false })),
    ])
    const result = await executor.executePlanStep("do the thing", createInitialContext("g"))
    expect(result.success).toBe(true)
    expect(result.output).toBe("written")
    expect(result.error).toBeUndefined()
  })

  it("fails closed when the required tool is not registered", async () => {
    const executor = executorWith([])
    const result = await executor.executePlanStep("do the thing", createInitialContext("g"))
    expect(result.success).toBe(false)
    expect(result.error).toBe("Unknown tool: write_file")
  })

  it("a session deny rule vetoes execution even when the tool exists", async () => {
    let executed = false
    const executor = executorWith([
      fakeTool(async () => {
        executed = true
        return { content: [{ type: "text", text: "should not run" }], isError: false }
      }),
    ])
    addSessionPermissionRule({ tool: "write_file", pattern: "*", action: "deny" })
    const result = await executor.executePlanStep("do the thing", createInitialContext("g"))
    expect(result.success).toBe(false)
    expect(result.error).toContain("Permission denied for write_file")
    expect(executed).toBe(false)
  })

  it("surfaces tool-level isError results as failures", async () => {
    const executor = executorWith([
      fakeTool(async () => ({ content: [{ type: "text", text: "tool exploded" }], isError: true })),
    ])
    const result = await executor.executePlanStep("do the thing", createInitialContext("g"))
    expect(result.success).toBe(false)
    expect(result.error).toBe("tool exploded")
  })

  it("catches thrown errors from the tool instead of crashing the loop", async () => {
    const executor = executorWith([
      fakeTool(async () => {
        throw new Error("kaboom")
      }),
    ])
    const result = await executor.executePlanStep("do the thing", createInitialContext("g"))
    expect(result.success).toBe(false)
    expect(result.error).toBe("kaboom")
  })

  it("executeFix wraps the error into the scratchpad write", async () => {
    const seen: Array<Record<string, unknown>> = []
    const executor = executorWith([
      fakeTool(async (_id, args) => {
        seen.push(args)
        return { content: [{ type: "text", text: "fixed" }], isError: false }
      }),
    ])
    const ctx = createInitialContext("g")
    const result = await executor.executeFix("NullReference: line 42", ctx)
    expect(result.success).toBe(true)
    expect(seen).toHaveLength(1)
    expect(String(seen[0]?.path)).toBe("scratchpad.txt")
    expect(String(seen[0]?.content)).toContain("NullReference: line 42")
  })
})
