/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as path from "path"

/**
 * CoT-4 Code Pipeline (written to nemo/5-eval).
 *
 * Pipeline:
 *   User Input
 *     -> Parallel 4-Code Generation
 *     -> Sandbox Execution
 *     -> Test Cases Check
 *     -> Error (Penalty) / Pass (Reward)
 *     -> Pick Best Code
 *     -> Output to User
 *
 * Every run is recorded to nemo/5-eval/cot.json and appended to
 * nemo/5-eval/COT-REPORT.md.
 */

export type CotDifficulty = "easy" | "medium" | "hard" | "insane"

export interface CotCandidate {
  id: number
  approach: string
  code: string
  status: "ran" | "error"
  output?: string
  exitCode?: number
  compileError?: string
  testsPassed?: boolean
  testOutput?: string
  reward: number
  review: string[]
}

export interface CotRecord {
  id: string
  timestamp: string
  userInput: string
  difficulty: CotDifficulty
  tests: string
  candidates: CotCandidate[]
  best?: CotCandidate
  finalOutput: string
  totalReward: number
}

export interface CotEngineDeps {
  generate: (prompt: string, opts?: { temperature?: number }) => Promise<string>
  execute: (code: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  runTests: (code: string, tests: string) => Promise<{ passed: boolean; output: string }>
}

export const COT_PARALLEL_COUNT = 4

export const COT_APPROACHES = ["brute-force-direct", "efficient-optimized", "robust-defensive", "minimal-clean"]

export const COT_SCORE = {
  testsPassed: 10,
  compilesOnly: 3,
  producedOutput: 2,
  compileError: -8,
  testFailed: -6,
  emptyOutput: -2,
  timeOut: -4,
}
function cotDir(): string {
  return path.join(process.cwd(), "nemo", "5-eval")
}

function cotFile(): string {
  return path.join(cotDir(), "cot.json")
}

function cotReportFile(): string {
  return path.join(cotDir(), "COT-REPORT.md")
}

export function loadCot(): CotRecord[] {
  try {
    if (!fs.existsSync(cotFile())) return []
    return JSON.parse(fs.readFileSync(cotFile(), "utf8")) as CotRecord[]
  } catch {
    return []
  }
}

export function saveCot(records: CotRecord[]): void {
  fs.mkdirSync(cotDir(), { recursive: true })
  fs.writeFileSync(cotFile(), JSON.stringify(records, null, 2), "utf8")
}
export function appendCotReport(record: CotRecord): void {
  try {
    const lines: string[] = []
    lines.push(`## CoT Run ${record.id} - ${record.timestamp}`)
    lines.push(`**Difficulty:** ${record.difficulty}`)
    lines.push("")
    lines.push(`**User Input:** ${record.userInput.slice(0, 500)}`)
    lines.push("")
    lines.push("| # | Approach | Status | Exit | Tests | Reward |")
    lines.push("|---|----------|--------|------|-------|--------|")
    for (const c of record.candidates) {
      lines.push(
        `| ${c.id} | ${c.approach} | ${c.status} | ${c.exitCode ?? "-"} | ${c.testsPassed === true ? "PASS" : c.testsPassed === false ? "FAIL" : "-"} | ${c.reward >= 0 ? "+" : ""}${c.reward} |`,
      )
    }
    lines.push("")
    if (record.best) {
      lines.push(
        `**Best:** candidate #${record.best.id} (${record.best.approach}), total reward ${record.totalReward >= 0 ? "+" : ""}${record.totalReward}`,
      )
      lines.push("")
      lines.push("```")
      lines.push(record.best.code)
      lines.push("```")
    } else {
      lines.push("**Best:** none - all candidates failed.")
    }
    lines.push("")
    fs.mkdirSync(cotDir(), { recursive: true })
    fs.appendFileSync(cotReportFile(), lines.join("\n") + "\n", "utf8")
  } catch {
    /* best-effort reporting */
  }
}
export function estimateCotDifficulty(input: string): CotDifficulty {
  const lower = input.toLowerCase()
  const len = input.length
  let score = 0
  if (len > 800) score += 3
  else if (len > 400) score += 2
  else if (len > 150) score += 1
  if (/```|function |class |def |import |const |let |=>|api|database|sql/i.test(input)) score += 2
  if (/frontend|backend|auth|cache|queue|deploy|concurrent|thread/i.test(lower)) score += 2
  if (/constraint|requirement|must|ensure|guarantee|validate|test|edge case/i.test(lower)) score += 1
  if (/could|might|possibly|ambiguous|either|or/i.test(lower)) score += 1
  if (score <= 2) return "easy"
  if (score <= 4) return "medium"
  if (score <= 7) return "hard"
  return "insane"
}

export function extractCodeBlock(text: string): string {
  const fenceRe = /```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/g
  const blocks: string[] = []
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text)) !== null) blocks.push(m[1])
  if (blocks.length > 0) return blocks[0].trim()
  return text.trim()
}

export function buildApproachPrompt(input: string, approach: string, index: number): string {
  const styles: Record<string, string> = {
    "brute-force-direct":
      "Write a straightforward, correct implementation that solves the task directly and is easy to reason about.",
    "efficient-optimized":
      "Write an optimized, efficient implementation focusing on performance and clean algorithmic structure.",
    "robust-defensive":
      "Write a defensive, robust implementation that validates inputs, handles edge cases and failures gracefully.",
    "minimal-clean":
      "Write the minimal, clean, idiomatic implementation that satisfies the requirement with the fewest moving parts.",
  }
  const style = styles[approach] ?? styles["minimal-clean"]
  return [
    "You are candidate #" + (index + 1) + " (" + approach + ") in a parallel code-generation pipeline.",
    "Task:",
    input,
    "",
    "Instructions:",
    "- " + style,
    "- Output ONLY one fenced code block encapsulating a complete, runnable program.",
    "- Do NOT include explanations outside the code block.",
  ].join("\n")
}
export async function runCotPipeline(userInput: string, deps: CotEngineDeps, tests: string = ""): Promise<CotRecord> {
  const difficulty = estimateCotDifficulty(userInput)

  // Step 1: Parallel 4-Code Generation.
  const approaches = COT_APPROACHES.slice(0, COT_PARALLEL_COUNT)
  const prompts = approaches.map((approach, i) => buildApproachPrompt(userInput, approach, i))
  const raw = await Promise.all(prompts.map((p, i) => deps.generate(p, { temperature: 0.7 + (i % 4) * 0.1 })))

  const candidates: CotCandidate[] = []
  for (let i = 0; i < approaches.length; i++) {
    const code = extractCodeBlock(raw[i])
    const candidate: CotCandidate = {
      id: i + 1,
      approach: approaches[i],
      code,
      status: "ran",
      reward: 0,
      review: [],
    }

    // Step 2: Sandbox Execution.
    let exec
    try {
      exec = await deps.execute(code)
    } catch (err) {
      candidate.status = "error"
      candidate.compileError = err instanceof Error ? err.message : String(err)
      candidate.reward += COT_SCORE.compileError
      candidate.review.push("sandbox failed to start")
      candidates.push(candidate)
      continue
    }

    candidate.exitCode = exec.exitCode
    candidate.output = (exec.stdout || "").slice(0, 2000)
    const stderr = (exec.stderr || "").slice(0, 1000)

    if (exec.exitCode > 0 || stderr.length > 0) {
      candidate.reward += COT_SCORE.compileError
      candidate.compileError = stderr || `exit code ${exec.exitCode}`
      candidate.review.push("compile/runtime error")
    } else {
      candidate.reward += COT_SCORE.compilesOnly
      if (candidate.output.length > 0) {
        candidate.reward += COT_SCORE.producedOutput
      } else {
        candidate.reward += COT_SCORE.emptyOutput
        candidate.review.push("empty output")
      }
    }

    // Step 3: Test Cases Check.
    if (tests && tests.trim().length > 0) {
      try {
        const testRun = await deps.runTests(code, tests)
        candidate.testsPassed = testRun.passed
        candidate.testOutput = testRun.output.slice(0, 1000)
        candidate.reward += testRun.passed ? COT_SCORE.testsPassed : COT_SCORE.testFailed
        candidate.review.push(testRun.passed ? "tests passed" : "tests failed")
      } catch {
        candidate.testsPassed = false
        candidate.reward += COT_SCORE.testFailed
        candidate.review.push("test harness error")
      }
    }

    candidates.push(candidate)
  }

  // Step 4: Pick Best Code.
  const best = [...candidates].sort((a, b) => b.reward - a.reward || a.id - b.id)[0]
  const totalReward = candidates.reduce((sum, c) => sum + c.reward, 0)

  const record: CotRecord = {
    id: `cot_${Date.now().toString(36)}`,
    timestamp: new Date().toISOString(),
    userInput,
    difficulty,
    tests,
    candidates,
    best,
    totalReward,
    finalOutput: best ? best.code : "",
  }

  saveCot([...loadCot(), record])
  appendCotReport(record)

  return record
}
export function summarizeCot(record: CotRecord): string {
  const lines = [
    `[Cot] difficulty=${record.difficulty} candidates=${record.candidates.length}`,
    `  scores: ${record.candidates.map((c) => `${c.approach}=${c.reward >= 0 ? "+" : ""}${c.reward}`).join(", ")}`,
  ]
  if (record.best) {
    lines.push(
      `  best: #${record.best.id} (${record.best.approach}) reward ${record.best.reward >= 0 ? "+" : ""}${record.best.reward}`,
    )
    lines.push(`  total reward: ${record.totalReward >= 0 ? "+" : ""}${record.totalReward}`)
    lines.push("")
    lines.push("```")
    lines.push(record.best.code)
    lines.push("```")
  } else {
    lines.push("  best: none (all candidates errored)")
  }
  return lines.join("\n")
}

export function getCotReport(): string {
  const records = loadCot()
  if (records.length === 0) return "No CoT pipeline runs recorded yet."
  const last = records[records.length - 1]
  return [
    "NEMO COT-4 PIPELINE REPORT (nemo/5-eval)",
    `Runs Recorded: ${records.length}`,
    `Last Run: ${last.id} at ${last.timestamp}`,
    `Last Difficulty: ${last.difficulty}`,
    `Last Total Reward: ${last.totalReward >= 0 ? "+" : ""}${last.totalReward}`,
    `Last Best: ${last.best ? `${last.best.approach} (#${last.best.id})` : "none"}`,
  ].join("\n")
}
