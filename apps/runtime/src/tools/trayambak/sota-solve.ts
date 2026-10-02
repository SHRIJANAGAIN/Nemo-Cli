/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { getSafeEnv } from "../../../../../packages/core/src/env_filter.js"
import type { Provider } from "../../../../../packages/provider/src/index.js"
import { createLlamaCppProvider } from "../../../../../packages/provider/src/llama-cpp.js"
import { createOllamaProvider } from "../../../../../packages/provider/src/ollama.js"
import { CotChainEngine, type CotChainConfig, type CotEvent } from "../../../../../skt/5-eval/cot-chain.js"
import { TaskAnalyzer, type SotaOptions, type VerificationResult } from "../../../../../apps/runtime/src/agent/sota.js"

/** Local-only backends allowed to drive inference-time search. The whole
 *  point is a local 3B performing like SOTA with weights untouched — no
 *  remote provider is ever connected for cot/sota work. */
const LOCAL_SEARCH_PROVIDER_IDS = new Set(["llama.cpp", "ollama"])

function localSearchProvider(context: ToolContext | undefined): Provider | undefined {
  const candidate = context?.provider
  return candidate && LOCAL_SEARCH_PROVIDER_IDS.has(candidate.id.toLowerCase()) ? candidate : undefined
}
import { runCotPipeline, summarizeCot, type CotEngineDeps } from "../../../../../skt/5-eval/cot.js"

export interface SotaSolveOptions {
  generate?: (prompt: string, opts?: { temperature?: number }) => Promise<string>
  /** Decision-maker for backend verdicts (verify/attack calls). Programmatic
   *  callers vouch that it is local (llama.cpp/Ollama) — same rule as every
   *  other model surface in cot/sota. Verdicts only; the worker model that
   *  writes candidates is still required. */
  judgeGenerate?: (prompt: string, opts?: { temperature?: number }) => Promise<string>
  execute?: (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  runTests?: (code: string, tests: string) => Promise<{ passed: boolean; output: string }>
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "sota_solve",
  description:
    "Run the CoT-4 parallel code-generation pipeline (User Input -> Parallel 4-Code Generation -> Bounded Code Execution -> Test Cases Check -> Error(Penalty)/Pass(Reward) -> Pick Best Code). Generates up to 4 distinct candidates, executes each as a bounded child process (filtered env, 15s kill, 256KB output cap; NOT OS-isolated), checks tests, applies reward/penalty, picks the best, and records the run to skt/5-eval/COT-REPORT.md. Pass 'tests' to grade candidates; pass 'mode=sota' for full inference-time search (branching, assumption-attack, independent verification) driven by the local llama.cpp/Ollama model — no remote provider is ever connected.",
  parameters: {
    type: "object",
    required: ["input"],
    properties: {
      input: {
        type: "string",
        description: "The coding task or spec. May include a fenced code block to seed candidates.",
      },
      tests: {
        type: "string",
        description: "Optional test harness / assertions used to grade each candidate.",
      },
      mode: {
        type: "string",
        enum: ["cot", "sota"],
        description:
          "'cot' (default) runs the 4-way parallel pipeline. 'sota' adds an extra inference-time re-solve and final independent verification pass.",
      },
    },
  },
}
export function createSotaSolveTool(options: SotaSolveOptions = {}): Tool {
  return {
    definition,
    async execute(_id, args, signal, _update, context: ToolContext | undefined) {
      const input = String(args.input ?? "").trim()
      if (!input) return textResult("Missing required parameter: input", /*isError*/ true)
      const tests = String(args.tests ?? "").trim()
      const mode = String(args.mode ?? "cot").toLowerCase()
      if (mode !== "cot" && mode !== "sota") {
        return textResult(`Invalid mode '${args.mode}'. Use 'cot' or 'sota'.`, /*isError*/ true)
      }
      const cwd = context?.cwd ?? process.cwd()

      try {
        if (mode === "sota") {
          return textResult(await runSotaSearch(input, tests, { options, context, signal, cwd }))
        }
        const deps: CotEngineDeps = {
          generate: buildCotGenerate(options, context),
          execute: options.execute ?? makeExecutor(cwd, signal),
          runTests: options.runTests ?? makeTestRunner(cwd, signal),
        }
        const record = await runCotPipeline(input, deps, tests)
        return textResult(summarizeCot(record))
      } catch (err) {
        return textResult(`sota_solve failed: ${err instanceof Error ? err.message : String(err)}`, /*isError*/ true)
      }
    },
  }
}

function extractFirstCode(text: string): string {
  const m = /```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/.exec(text)
  return m ? m[1].trim() : ""
}

function seedFromInput(input: string): string {
  const code = extractFirstCode(input)
  if (code) return code
  return "// generated candidate\n" + input.slice(0, 1200)
}

/** Filtered child env for model-generated code: never inherit API keys
 *  wholesale (same boundary as hook/MCP children). Exported for tests. */
export function sotaChildEnv(extra?: Record<string, string>): Record<string, string> {
  return { ...getSafeEnv(process.env), ...(extra ?? {}) }
}

/** Bounds for model-generated code execution — the same ceilings every
 *  other child boundary in this repo runs under (hook children, gitExec):
 *  a deadline, a 256KB output cap, and abort kill. Without them a
 *  prompt-injected candidate (`while (true) {}`, a forever-printing loop)
 *  outlives the tool timeout as an orphan spinning on CPU or wedging the
 *  process against an unbounded stdout buffer. Exported for tests. */
export const SOTA_EXEC_TIMEOUT_MS = 15_000
export const SOTA_OUTPUT_CAP_BYTES = 256 * 1024

export function boundedRun(
  cmd: string,
  args: string[],
  opts: {
    cwd: string
    env: Record<string, string>
    signal?: AbortSignal
    timeoutMs?: number
    capBytes?: number
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const cap = opts.capBytes ?? SOTA_OUTPUT_CAP_BYTES
    const timeoutMs = opts.timeoutMs ?? SOTA_EXEC_TIMEOUT_MS
    let stdout = ""
    let stderr = ""
    let settled = false
    let killReason: string | null = null

    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true })

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve({ stdout, stderr, exitCode })
    }
    const killChild = (reason: string): void => {
      if (settled || killReason) return
      killReason = reason
      stderr += (stderr ? "\n" : "") + `[boundedRun] ${reason}`
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    }
    const timer = setTimeout(() => killChild(`timed out after ${timeoutMs}ms`), timeoutMs)
    const onAbort = (): void => killChild("aborted by caller signal")
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
      if (stdout.length + stderr.length > cap) killChild(`output cap of ${cap} bytes exceeded`)
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8")
      if (stdout.length + stderr.length > cap) killChild(`output cap of ${cap} bytes exceeded`)
    })
    child.on("error", (e) => {
      stderr += (stderr ? "\n" : "") + e.message
      finish(1)
    })
    child.on("close", (code) => finish(killReason ? 1 : (code ?? 0)))
  })
}

/** Model source for generation, shared by both modes. Explicit
 *  options.generate wins (programmatic callers vouch that it is local);
 *  otherwise the gated loop provider; otherwise the offline seed.
 *  Non-local providers are refused — inference-time search stays on
 *  llama.cpp/Ollama only. Per-call failure falls back to the seed so one
 *  bad call never kills its siblings. ChatInput carries no temperature —
 *  the provider uses its configured defaults. */
function buildCotGenerate(options: SotaSolveOptions, context: ToolContext | undefined): CotEngineDeps["generate"] {
  if (options.generate) return options.generate
  return async (prompt: string) => {
    const provider = localSearchProvider(context)
    if (provider) {
      // Raw model text, always: verification/attack/reverse replies are
      // prose by design, and gating on fenced blocks here turned every
      // one of them into seed prose (all-UNCERTAIN cascade). Callers that
      // need code extract it themselves; only a provider FAILURE falls
      // back to the offline seed.
      try {
        const msg = await provider.chat({ messages: [{ role: "user", content: prompt }] })
        return msg.content.map((p) => ("text" in p ? String(p.text) : "")).join("\n")
      } catch {
        /* fall through to offline seed */
      }
    }
    const code = extractFirstCode(prompt)
    return code ? `\`\`\`\n${code}\n\`\`\`` : `\`\`\`\n${seedFromInput(prompt)}\n\`\`\``
  }
}

/** Decision-maker provider for backend verdicts, built from the configured
 *  `judge_model` on the SAME local backend as the worker (llama.cpp stays
 *  llama.cpp, Ollama stays Ollama). Anything else — unset key, missing
 *  config, non-local worker, construction failure — returns null and the
 *  worker verifies itself. Verdict temperature is fixed low: judges must
 *  be steady, not creative. */
function buildJudgeGenerate(
  context: ToolContext | undefined,
): ((prompt: string, opts?: { temperature?: number }) => Promise<string>) | null {
  const model = context?.config?.judge_model?.trim()
  const worker = localSearchProvider(context)
  const cfg = context?.config
  if (!model || !worker || !cfg) return null
  let judge: Provider
  try {
    const base = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model, temperature: 0.1 }
    judge = worker.id.toLowerCase() === "ollama" ? createOllamaProvider(base) : createLlamaCppProvider(base)
  } catch {
    return null
  }
  return async (prompt: string) => {
    const msg = await judge.chat({ messages: [{ role: "user", content: prompt }] })
    return msg.content.map((p) => ("text" in p ? String(p.text) : "")).join("\n")
  }
}

/** Difficulty-adaptive search budget: easy stays cheap, hard spends. */
function chainConfigFor(difficulty: string): CotChainConfig {
  const base = {
    enabled: true,
    verifier: "both",
    uncertaintyThreshold: 0.4,
    reverseVerification: true,
    externalizedScratchpad: true,
  } as const
  switch (difficulty) {
    case "easy":
      return {
        ...base,
        maxDepth: 3,
        branchFactor: 2,
        infoGainBasedSearch: false,
        debateRounds: 0,
        assumptionAttack: false,
      }
    case "medium":
      return {
        ...base,
        maxDepth: 6,
        branchFactor: 3,
        infoGainBasedSearch: true,
        debateRounds: 0,
        assumptionAttack: true,
      }
    default: // hard, insane
      return {
        ...base,
        maxDepth: 10,
        branchFactor: 4,
        infoGainBasedSearch: true,
        debateRounds: 2,
        assumptionAttack: true,
      }
  }
}

/** Independent verifier built from the same local model source: PASS /
 *  FAIL / UNCERTAIN parsed off the first line, heuristic scores after. */
async function verifyWithModel(
  gen: (prompt: string, opts?: { temperature?: number }) => Promise<string>,
  problem: string,
  solution: string,
): Promise<VerificationResult> {
  const text = await gen(
    `You are a verifier. Read the problem and the candidate solution. Reply with exactly one word on the first line: PASS if the solution is correct, FAIL if it is wrong, UNCERTAIN if you cannot decide. Then give one line of evidence.\n\nProblem:\n${problem}\n\nSolution:\n${solution}`,
    { temperature: 0.1 },
  )
  const head = text.trim().toUpperCase()
  const correctness = head.startsWith("PASS") ? "PASS" : head.startsWith("FAIL") ? "FAIL" : "UNCERTAIN"
  const [consistency, progress, confidence] =
    correctness === "PASS" ? [0.9, 0.9, 0.8] : correctness === "FAIL" ? [0.2, 0.2, 0.2] : [0.5, 0.5, 0.4]
  return { correctness, evidence: [text.slice(0, 500)], consistency, progress, confidence }
}

/** Full inference-time search (the sota path): difficulty budget, branch +
 *  verify + prune, assumption attack, reverse check, disagreement
 *  resolution — then code grounding (execute + test harness) when the best
 *  carries code. Every claim in the output corresponds to a call that ran. */
async function runSotaSearch(
  input: string,
  tests: string,
  init: { options: SotaSolveOptions; context: ToolContext | undefined; signal: AbortSignal | undefined; cwd: string },
): Promise<string> {
  const { options, context, signal, cwd } = init
  const hasModel = !!options.generate || !!localSearchProvider(context)
  if (!hasModel) {
    throw new Error(
      "sota search needs a local model — run inside the agent loop on llama.cpp/Ollama, or pass options.generate (local only)",
    )
  }
  const cotGen = buildCotGenerate(options, context)
  // Judge for backend verdicts: explicit judgeGenerate wins, else the
  // configured judge_model on the same local backend, else the worker
  // verifies itself (today's behavior, kept as the fallback).
  const injectedJudge = options.judgeGenerate ?? null
  const configuredJudge = injectedJudge ? null : buildJudgeGenerate(context)
  const judgeGen = injectedJudge ?? configuredJudge
  const verifyGen = judgeGen ?? cotGen
  const trail: string[] = []
  if (judgeGen) {
    trail.push(
      `judge: ${injectedJudge ? "injected" : (context?.config?.judge_model?.trim() ?? "model")} (backend verdicts)`,
    )
  }
  const sotaOptions: SotaOptions = {
    generate: async (system, messages, opts) => {
      const convo = messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n\n")
      return cotGen(`${system}\n\n${convo}`, { temperature: opts?.temperature })
    },
    verify: (problem, solution) => verifyWithModel(verifyGen, problem, solution),
    signal: signal ?? undefined,
    onEvent: (e: CotEvent) => {
      // The engine reports its own analysis, which is identical by
      // construction (same pure analyzer, same input) — no duplicate line.
      if (e.type === "assumption_attacked") {
        trail.push(`assumption attack: ${e.critique.slice(0, 160)}`)
      } else if (e.type === "reverse_verify") {
        trail.push(`reverse verification: ${e.passed ? "PASS" : "FAIL"}`)
      } else if (e.type === "solution_found") {
        trail.push(
          `best: ${e.candidate.id} score=${e.candidate.score.toFixed(2)} (${e.candidate.verification.correctness})`,
        )
      } else if (e.type === "search_complete") {
        trail.push(`ranked ${e.candidates.length} candidates`)
      }
    },
  }
  // Single difficulty source: the engine analyzes with this same pure
  // function internally, so config and trail can never disagree again.
  const analysis = new TaskAnalyzer().analyze(input)
  const difficulty = analysis.difficulty
  const engine = new CotChainEngine(sotaOptions, chainConfigFor(difficulty))
  const best = await engine.solve(input)

  const lines = [`[sota search] difficulty=${difficulty} (${analysis.category})`, ...trail]
  if (!best) {
    lines.push("No candidate survived the search.")
    return lines.join("\n")
  }
  // Explicit (not event-derived): the attack path returns before
  // solution_found/search_complete emit, so the verdict is stated here.
  lines.push(`selected: verification=${best.verification.correctness} score=${best.score.toFixed(2)}`)
  const code = extractFirstCode(best.text)
  if (!code) {
    lines.push("", best.text.slice(0, 2000))
    return lines.join("\n")
  }
  try {
    const exec = await (options.execute ?? makeExecutor(cwd, signal))(code)
    const execBits = [`exit=${exec.exitCode}`]
    if (exec.stdout) execBits.push(`stdout=${exec.stdout.slice(0, 300)}`)
    if (exec.stderr) execBits.push(`stderr=${exec.stderr.slice(0, 300)}`)
    lines.push(`execute: ${execBits.join(" ")}`)
    if (tests) {
      const t = await (options.runTests ?? makeTestRunner(cwd, signal))(code, tests)
      lines.push(`tests: ${t.passed ? "PASS" : `FAIL: ${t.output.slice(0, 500)}`}`)
    } else {
      lines.push("tests: skipped (no tests provided)")
    }
  } catch (e) {
    lines.push(`grounding error: ${e instanceof Error ? e.message : String(e)}`)
  }
  lines.push("", "```", code, "```")
  return lines.join("\n")
}

function detectLang(code: string): "js" | "python" | "unknown" {
  if (/function\s+\w+\s*\(|=>|const\s+\w+\s*=|require\(|import\s+.*from|console\.log/i.test(code)) return "js"
  if (/^\s*(def|class)\s+\w+|print\s*\(|\b:\s*$/m.test(code) || /\bif\s+__name__\s*==/.test(code)) return "python"
  return "unknown"
}

function makeExecutor(
  cwd: string,
  signal?: AbortSignal,
): (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return (code: string) => {
    const execPair = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      boundedRun(cmd, args, { cwd, env: sotaChildEnv(), signal })
    const lang = detectLang(code)
    const scratch = path.join(cwd, ".scratchpad")
    try {
      fs.mkdirSync(scratch, { recursive: true })
    } catch {
      /* ignore */
    }
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (lang === "js") {
      const file = path.join(scratch, `cot-${tag}.js`)
      try {
        fs.writeFileSync(file, code, "utf8")
      } catch (e) {
        return Promise.resolve({ stdout: "", stderr: `write error: ${e}`, exitCode: 1 })
      }
      return execPair("node", [file])
    }
    if (lang === "python") {
      const file = path.join(scratch, `cot-${tag}.py`)
      try {
        fs.writeFileSync(file, code, "utf8")
      } catch (e) {
        return Promise.resolve({ stdout: "", stderr: `write error: ${e}`, exitCode: 1 })
      }
      return execPair("python", [file])
    }
    return Promise.resolve({ stdout: "", stderr: `unsupported language '${lang}'`, exitCode: 1 })
  }
}
function makeTestRunner(
  cwd: string,
  signal?: AbortSignal,
): (code: string, tests: string) => Promise<{ passed: boolean; output: string }> {
  return async (code: string, tests: string) => {
    const scratch = path.join(cwd, ".scratchpad")
    try {
      fs.mkdirSync(scratch, { recursive: true })
    } catch {
      /* ignore */
    }
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    if (detectLang(code) === "python") {
      const file = path.join(scratch, `cottest-${tag}.py`)
      const combined = `${code}\n\n# ---- tests ----\n${tests}\n`
      try {
        fs.writeFileSync(file, combined, "utf8")
      } catch (e) {
        return { passed: false, output: `write error: ${e}` }
      }
      const res = await boundedRun("python", [file], { cwd, env: sotaChildEnv(), signal })
      const failed = res.exitCode !== 0 || /assertionerror|traceback/i.test(res.stderr)
      return { passed: !failed, output: (res.stdout + res.stderr).slice(0, 2000) }
    }

    // Default JS harness via node + assert.
    const file = path.join(scratch, `cottest-${tag}.js`)
    const harness = [
      code,
      "",
      "const assert = require('assert');",
      "(async () => {",
      "  try {",
      tests,
      "    console.log('TESTS_PASSED');",
      "    process.exit(0);",
      "  } catch (e) {",
      "    console.error('TESTS_FAILED: ' + (e.message || e));",
      "    process.exit(1);",
      "  }",
      "})();",
    ].join("\n")
    try {
      fs.writeFileSync(file, harness, "utf8")
    } catch (e) {
      return { passed: false, output: `write error: ${e}` }
    }
    const res = await boundedRun("node", [file], { cwd, env: sotaChildEnv(), signal })
    const passed = res.exitCode === 0 && /TESTS_PASSED/.test(res.stdout)
    return { passed, output: (res.stdout + res.stderr).slice(0, 2000) }
  }
}
