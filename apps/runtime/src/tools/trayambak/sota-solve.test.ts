/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * sota_solve — the CoT engine is mocked (the real one appends cot.json /
 * COT-REPORT.md under cwd — never touch the repo from tests). Injected
 * generate/execute/runTests stubs, no processes.
 *
 * Pins the fixes:
 *  - mode=sota performs a REAL re-solve + verification (the old code only
 *    appended a claim sentence while running zero extra calls)
 *  - invalid mode is rejected instead of silently running cot
 *  - model-generated code spawns with a filtered env (sotaChildEnv)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolContext, ToolResult } from "../types.js"
import type { CotEngineDeps } from "../../../../../skt/5-eval/cot.js"
import type { Provider } from "../../../../../packages/provider/src/index.js"
import { createSotaSolveTool, sotaChildEnv, type SotaSolveOptions } from "./sota-solve.js"

type Best = { id: number; approach: string; code: string }

const ctl = vi.hoisted(() => ({
  record: null as null | { best?: Best },
  pipelineCalls: [] as Array<{ input: string; tests: string }>,
  deps: null as null | CotEngineDeps,
  reset(): void {
    ctl.record = null
    ctl.pipelineCalls.length = 0
    ctl.deps = null
  },
}))

vi.mock("../../../../../skt/5-eval/cot.js", () => ({
  runCotPipeline: async (input: string, deps: CotEngineDeps, tests: string) => {
    ctl.pipelineCalls.push({ input, tests })
    ctl.deps = deps
    return ctl.record
  },
  summarizeCot: (r: { best?: { id: number } }) => `summary best=${r.best?.id ?? "none"}`,
}))

const judgeCtl = vi.hoisted(() => ({
  factoryCalls: [] as Array<unknown>,
  calls: [] as Array<string>,
  reset(): void {
    judgeCtl.factoryCalls.length = 0
    judgeCtl.calls.length = 0
  },
}))

vi.mock("../../../../../packages/provider/src/llama-cpp.js", () => ({
  createLlamaCppProvider: (opts: unknown) => {
    judgeCtl.factoryCalls.push(opts)
    return {
      id: "llama.cpp",
      chat: async (input: { messages: Array<{ content: unknown }> }) => {
        const prompt = input.messages.map((m) => String(m.content)).join("\n")
        judgeCtl.calls.push(prompt)
        const text = prompt.startsWith("You are a verifier") ? "PASS\nEvidence: holds." : "```js\nconst jcode = 1\n```"
        return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }
      },
    }
  },
}))

function firstText(result: ToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : ""
}

const BEST: Best = { id: 2, approach: "efficient-optimized", code: "const a = 1" }

function stubs(overrides: Partial<SotaSolveOptions> = {}): SotaSolveOptions & {
  generateCalls: string[]
  runTestCalls: Array<{ code: string; tests: string }>
} {
  const generateCalls: string[] = []
  const runTestCalls: Array<{ code: string; tests: string }> = []
  return {
    generateCalls,
    runTestCalls,
    generate:
      overrides.generate ??
      (async (prompt: string) => {
        generateCalls.push(prompt)
        return "```js\nconst refined = true\n```"
      }),
    execute: overrides.execute ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    runTests:
      overrides.runTests ??
      (async (code: string, tests: string) => {
        runTestCalls.push({ code, tests })
        return { passed: true, output: "ok" }
      }),
  }
}

/** Options without generate: forces the tool's own model-source resolution. */
function bare(): SotaSolveOptions {
  return {
    execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    runTests: async () => ({ passed: true, output: "ok" }),
  }
}

async function run(
  args: Record<string, unknown>,
  options: SotaSolveOptions,
  context?: { provider?: Provider; cwd?: string },
): Promise<ToolResult> {
  return createSotaSolveTool(options).execute("t1", args, undefined, undefined, context as unknown as ToolContext)
}

beforeEach(() => {
  ctl.reset()
  judgeCtl.reset()
  ctl.record = { best: { ...BEST } }
  vi.stubEnv("SOTA_LEAK_PROBE_SECRET", "topsecret")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("guards", () => {
  it("rejects missing input and invalid mode", async () => {
    const o = stubs()
    const missing = await run({}, o)
    expect(missing.isError).toBe(true)
    expect(firstText(missing)).toBe("Missing required parameter: input")

    const badMode = await run({ input: "x", mode: "turbo" }, o)
    expect(badMode.isError).toBe(true)
    expect(firstText(badMode)).toContain("Use 'cot' or 'sota'")
  })
})

describe("cot mode", () => {
  it("runs the pipeline with zero extra calls and no sota claims", async () => {
    const o = stubs()
    const res = await run({ input: "add one", tests: "assert(a)", mode: "cot" }, o)
    expect(res.isError).toBe(false)
    expect(firstText(res)).toContain("summary best=2")
    expect(firstText(res)).not.toContain("[sota mode]")
    expect(ctl.pipelineCalls).toEqual([{ input: "add one", tests: "assert(a)" }])
    expect(o.generateCalls).toHaveLength(0)
    expect(o.runTestCalls).toHaveLength(0)
  })
})

describe("sota mode (inference-time search on the local model)", () => {
  const ATTACK_CLEAN = "WEAKEST ASSUMPTION: none\nIMPACT: none\nVULNERABLE: no"
  const ATTACK_HIT = "WEAKEST ASSUMPTION: unchecked bounds\nIMPACT: total collapse\nVULNERABLE: yes"

  /** One stub answering every engine prompt shape by prefix. */
  function engineStubs(attackText: string) {
    let n = 0
    const generateCalls: string[] = []
    const answerFor = (prompt: string): string => {
      if (prompt.startsWith("You are a verifier")) return "PASS\nEvidence: holds."
      if (prompt.includes("destroy this solution")) return attackText
      if (prompt.includes("work backwards")) return "Analysis: the solution addresses the problem."
      if (prompt.includes("Solve this problem independently")) return "```js\nconst indep = 1\n```"
      n++
      return `\`\`\`js\nconst branch${n} = ${n}\n\`\`\``
    }
    const executed: string[] = []
    const tested: Array<{ code: string; tests: string }> = []
    const options: SotaSolveOptions = {
      generate: async (prompt: string) => {
        generateCalls.push(prompt)
        return answerFor(prompt)
      },
      execute: async (code: string) => {
        executed.push(code)
        return { stdout: "", stderr: "", exitCode: 0 }
      },
      runTests: async (code: string, tests: string) => {
        tested.push({ code, tests })
        return { passed: true, output: "ok" }
      },
    }
    return { options, generateCalls, executed, tested }
  }

  it("searches, verifies, attacks, grounds, and picks the best", async () => {
    const s = engineStubs(ATTACK_CLEAN)
    // Medium on the real analyzer: 50-200 chars + a single-domain word.
    const input = "fix the login function bug and add test coverage for retry edge cases now please verify ok"
    const res = await run({ input, tests: "assert(x)", mode: "sota" }, s.options)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    // The search actually ran (old code made zero model calls here).
    expect(s.generateCalls.length).toBeGreaterThan(3)
    expect(text).toContain("[sota search] difficulty=medium (coding)")
    expect(text).toContain("assumption attack:")
    expect(text).toContain("reverse verification: PASS")
    expect(text).toContain("ranked 3 candidates")
    expect(text).toContain("selected: verification=PASS")
    // Stable ties keep insertion order: best is branch 1, grounded for real.
    expect(s.executed).toEqual(["const branch1 = 1"])
    expect(s.tested).toEqual([{ code: "const branch1 = 1", tests: "assert(x)" }])
    expect(text).toContain("execute: exit=0")
    expect(text).toContain("tests: PASS")
    expect(text).toContain("const branch1 = 1")
    expect(text).not.toContain("const branch2")
  })

  it("an assumption attack that lands switches the answer", async () => {
    const s = engineStubs(ATTACK_HIT)
    const input = "fix the login function bug and add test coverage for retry edge cases now please verify ok"
    const res = await run({ input, tests: "assert(x)", mode: "sota" }, s.options)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("const branch2 = 2")
    expect(text).not.toContain("const branch1")
    expect(s.executed).toEqual(["const branch2 = 2"])
  })

  it("reports reasoning text when the best carries no code", async () => {
    const options: SotaSolveOptions = {
      generate: async (prompt: string) =>
        prompt.startsWith("You are a verifier")
          ? "PASS\nEvidence: holds."
          : "This problem calls for patience and recursion.",
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runTests: async () => ({ passed: true, output: "ok" }),
    }
    const res = await run({ input: "think deep", mode: "sota" }, options)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("patience and recursion")
    expect(text).not.toContain("execute:")
  })

  it("drives the engine through a local llama.cpp provider", async () => {
    const chatCalls: string[] = []
    let n = 0
    const llama: Provider = {
      id: "llama.cpp",
      chat: async (input) => {
        const prompt = input.messages.map((m) => String(m.content)).join("\n")
        chatCalls.push(prompt)
        const text = prompt.startsWith("You are a verifier")
          ? "PASS\nEvidence: holds."
          : prompt.includes("destroy this solution")
            ? ATTACK_CLEAN
            : prompt.includes("work backwards")
              ? "Analysis: the solution addresses the problem."
              : prompt.includes("Solve this problem independently")
                ? "```js\nconst indep = 1\n```"
                : `\`\`\`js\nconst branch${++n} = ${n}\n\`\`\``
        return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }
      },
    }
    const res = await run({ input: "add one", mode: "sota" }, bare(), { provider: llama })
    expect(res.isError).toBe(false)
    expect(chatCalls.length).toBeGreaterThan(3)
    expect(firstText(res)).toContain("[sota search] difficulty=easy")
    expect(firstText(res)).toContain("const branch1 = 1")
  })

  it("refuses a non-local provider without contacting it", async () => {
    let contacted = false
    const remote: Provider = {
      id: "openai",
      chat: async () => {
        contacted = true
        throw new Error("must never happen")
      },
    }
    const res = await run({ input: "add one", mode: "sota" }, bare(), { provider: remote })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("local model")
    expect(contacted).toBe(false)
  })

  it("refuses sota with no model at all", async () => {
    const res = await run({ input: "add one", mode: "sota" }, bare())
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("local model")
  })
})

describe("judge model (backend verdicts, local-only)", () => {
  const workerCode = "```js\nconst w = 1\n```"

  function workerOptions(workerCalls: string[]): SotaSolveOptions {
    return {
      generate: async (prompt: string) => {
        workerCalls.push(prompt)
        return workerCode
      },
      execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      runTests: async () => ({ passed: true, output: "ok" }),
    }
  }

  it("routes verdicts to an injected judge, branches stay on the worker", async () => {
    const workerCalls: string[] = []
    const judgeCalls: string[] = []
    const options = {
      ...workerOptions(workerCalls),
      judgeGenerate: async (prompt: string) => {
        judgeCalls.push(prompt)
        return "PASS\nEvidence: holds."
      },
    }
    const res = await run({ input: "add one", mode: "sota" }, options)
    expect(res.isError).toBe(false)
    // Every verifier prompt went to the judge…
    expect(judgeCalls.length).toBeGreaterThan(0)
    expect(judgeCalls.every((p) => p.startsWith("You are a verifier"))).toBe(true)
    // …and none to the worker.
    expect(workerCalls.some((p) => p.startsWith("You are a verifier"))).toBe(false)
    expect(firstText(res)).toContain("judge: injected (backend verdicts)")
    expect(firstText(res)).toContain("selected: verification=PASS")
  })

  it("builds the judge from judge_model on the same local backend", async () => {
    const workerCalls: string[] = []
    const ctx = {
      provider: { id: "llama.cpp", chat: async () => ({ role: "assistant", content: [], stopReason: "end_turn" }) },
      config: {
        judge_model: "convaiinnovations/laya-multilingual",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "",
      },
    } as unknown as ToolContext
    const res = await run({ input: "add one", mode: "sota" }, workerOptions(workerCalls), ctx)
    expect(res.isError).toBe(false)
    // Factory got the user's model on the worker's backend family…
    expect(judgeCtl.factoryCalls).toHaveLength(1)
    expect(judgeCtl.factoryCalls[0]).toMatchObject({ model: "convaiinnovations/laya-multilingual" })
    // …verdicts flowed through it, branches stayed on the worker.
    expect(judgeCtl.calls.length).toBeGreaterThan(0)
    expect(judgeCtl.calls.every((p) => p.startsWith("You are a verifier"))).toBe(true)
    expect(workerCalls.some((p) => p.startsWith("You are a verifier"))).toBe(false)
    expect(firstText(res)).toContain("judge: convaiinnovations/laya-multilingual (backend verdicts)")
  })

  it("never builds a judge for a non-local worker, even with judge_model set", async () => {
    const workerCalls: string[] = []
    const ctx = {
      provider: { id: "openai", chat: async () => ({ role: "assistant", content: [], stopReason: "end_turn" }) },
      config: {
        judge_model: "convaiinnovations/laya-multilingual",
        baseUrl: "http://127.0.0.1:9",
        apiKey: "",
      },
    } as unknown as ToolContext
    const res = await run({ input: "add one", mode: "sota" }, workerOptions(workerCalls), ctx)
    expect(res.isError).toBe(false)
    expect(judgeCtl.factoryCalls).toHaveLength(0)
    expect(firstText(res)).not.toContain("judge:")
  })
})

describe("sotaChildEnv", () => {
  it("strips secrets, keeps PATH, lets explicit values win", () => {
    const env = sotaChildEnv({ EXPLICIT: "yes" })
    expect(env["SOTA_LEAK_PROBE_SECRET"]).toBeUndefined()
    expect(env["PATH"]).toBe(process.env["PATH"])
    expect(env["EXPLICIT"]).toBe("yes")
  })
})

describe("context provider wiring (production liveness)", () => {
  const liveProvider = (text: string): Provider => ({
    id: "llama.cpp",
    chat: async (input) => {
      expect(input.messages).toHaveLength(1)
      return { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }
    },
  })

  const bare = (): SotaSolveOptions => ({
    execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    runTests: async () => ({ passed: true, output: "ok" }),
  })

  it("generates through the context provider when present", async () => {
    await run({ input: "add one", mode: "cot" }, bare(), {
      provider: liveProvider("```js\nconst live = 1\n```"),
    })
    expect(ctl.deps).not.toBeNull()
    const out = await ctl.deps!.generate("make fenced js code")
    expect(out).toContain("const live = 1")
  })

  it("falls back to the offline seed when the provider throws", async () => {
    const throwing: Provider = {
      id: "llama.cpp",
      chat: async () => {
        throw new Error("model down")
      },
    }
    await run({ input: "add one", mode: "cot" }, bare(), { provider: throwing })
    const out = await ctl.deps!.generate("make fenced js code")
    expect(out).toContain("generated candidate")
  })

  it("falls back to the offline seed without a provider", async () => {
    await run({ input: "add one", mode: "cot" }, bare())
    const out = await ctl.deps!.generate("make fenced js code")
    expect(out).toContain("generated candidate")
  })
})
