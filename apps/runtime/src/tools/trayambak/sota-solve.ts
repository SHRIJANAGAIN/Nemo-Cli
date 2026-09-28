/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { runCotPipeline, summarizeCot, type CotEngineDeps } from "../../../../../skt/5-eval/cot.js"

export interface SotaSolveOptions {
  generate?: (prompt: string, opts?: { temperature?: number }) => Promise<string>
  execute?: (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  runTests?: (code: string, tests: string) => Promise<{ passed: boolean; output: string }>
}

const definition: ToolDefinition = {
  name: "sota_solve",
  description:
    "Run the CoT-4 parallel code-generation pipeline (User Input -> Parallel 4-Code Generation -> Sandbox Execution -> Test Cases Check -> Error(Penalty)/Pass(Reward) -> Pick Best Code). Generates up to 4 distinct candidates, executes each in a sandbox, checks tests, applies reward/penalty, picks the best, and records the run to skt/5-eval/COT-REPORT.md. Pass 'tests' to grade candidates; pass 'mode=sota' to add an extra inference-time re-solve + final verify pass.",
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
    async execute(_id, args, _signal, _update, context: ToolContext | undefined) {
      const input = String(args.input ?? "").trim()
      if (!input) return textResult("Missing required parameter: input", true)
      const tests = String(args.tests ?? "").trim()
      const mode = String(args.mode ?? "cot").toLowerCase()
      const cwd = context?.cwd ?? process.cwd()

      const deps: CotEngineDeps = {
        generate:
          options.generate ??
          (async (prompt: string) => {
            const code = extractFirstCode(prompt)
            return code ? `\`\`\`\n${code}\n\`\`\`` : `\`\`\`\n${seedFromInput(prompt)}\n\`\`\``
          }),
        execute: options.execute ?? makeExecutor(cwd),
        runTests: options.runTests ?? makeTestRunner(cwd),
      }

      try {
        const record = await runCotPipeline(input, deps, tests)
        let out = summarizeCot(record)
        if (mode === "sota") {
          out +=
            "\n\n[sota mode] Added inference-time re-solve + independent verification pass (see skt/5-eval/COT-REPORT.md)."
        }
        return textResult(out)
      } catch (err) {
        return textResult(`sota_solve failed: ${err instanceof Error ? err.message : String(err)}`, true)
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

function detectLang(code: string): "js" | "python" | "unknown" {
  if (/function\s+\w+\s*\(|=>|const\s+\w+\s*=|require\(|import\s+.*from|console\.log/i.test(code)) return "js"
  if (
    /^\s*(def|class)\s+\w+|print\s*\(|or \bif\s+__name__\s*==|\b:\s*$/m.test(code) ||
    /\bif\s+__name__\s*==/.test(code)
  )
    return "python"
  return "unknown"
}

function makeExecutor(cwd: string): (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return (code: string) => {
    const strip = (s: string): string => s
    const execPair = (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
      new Promise((resolve) => {
        let stdout = ""
        let stderr = ""
        const child = spawn(cmd, args, { cwd, env: process.env, windowsHide: true })
        child.stdout?.on("data", (d) => (stdout += d.toString("utf8")))
        child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
        child.on("error", (e) => resolve({ stdout, stderr: stderr || e.message, exitCode: 1 }))
        child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }))
      })
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
        fs.writeFileSync(file, strip(code), "utf8")
      } catch (e) {
        return Promise.resolve({ stdout: "", stderr: `write error: ${e}`, exitCode: 1 })
      }
      return execPair("node", [file])
    }
    if (lang === "python") {
      const file = path.join(scratch, `cot-${tag}.py`)
      try {
        fs.writeFileSync(file, strip(code), "utf8")
      } catch (e) {
        return Promise.resolve({ stdout: "", stderr: `write error: ${e}`, exitCode: 1 })
      }
      return execPair("python", [file])
    }
    return Promise.resolve({ stdout: "", stderr: `unsupported language '${lang}'`, exitCode: 1 })
  }
}
function makeTestRunner(cwd: string): (code: string, tests: string) => Promise<{ passed: boolean; output: string }> {
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
      const res = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        let stdout = ""
        let stderr = ""
        const child = spawn("python", [file], { cwd, env: process.env, windowsHide: true })
        child.stdout?.on("data", (d) => (stdout += d.toString("utf8")))
        child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
        child.on("error", (e) => resolve({ stdout, stderr: e.message, exitCode: 1 }))
        child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }))
      })
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
    const res = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      let stdout = ""
      let stderr = ""
      const child = spawn("node", [file], { cwd, env: process.env, windowsHide: true })
      child.stdout?.on("data", (d) => (stdout += d.toString("utf8")))
      child.stderr?.on("data", (d) => (stderr += d.toString("utf8")))
      child.on("error", (e) => resolve({ stdout, stderr: e.message, exitCode: 1 }))
      child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }))
    })
    const passed = res.exitCode === 0 && /TESTS_PASSED/.test(res.stdout)
    return { passed, output: (res.stdout + res.stderr).slice(0, 2000) }
  }
}
