/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * trayambak__ParallelReview — injected subagent runner, no processes.
 *
 * Pins the fixes:
 *  - no runner → honest isError (the old fallback fabricated APPROVE with
 *    "Dimensions Reviewed" for reviewers that never executed — fail-open
 *    on a review gate)
 *  - `files` passed as a single string is coerced (models do this often;
 *    the old code silently dropped the selection)
 *  - non-string `diff` can no longer throw on `.trim()`
 * Plus the fail-closed core: failed dimensions and unverified blockers
 * force CHANGES_REQUESTED; refuted findings move to advisory.
 */

import { describe, expect, it } from "vitest"
import type { ToolResult } from "../types.js"
import { createParallelReviewTool } from "./parallel-review.js"

type Task = { name: string; prompt: string; subagentType?: string }
type TaskResult = { name: string; text: string; error?: string }

function firstText(result: ToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : ""
}

const DIFF = `diff --git a/db.ts b/db.ts
+const query = 'SELECT ' + input;`

const CRITICAL_JSON = JSON.stringify({
  findings: [
    {
      title: "SQL injection in query builder",
      severity: "CRITICAL",
      file: "db.ts",
      line: 5,
      evidence: "query = 'SELECT ' + input",
      proof: "unsanitized concat flows to execute",
      fix: "parameterize the query",
    },
  ],
})

async function run(
  args: Record<string, unknown>,
  onRunSubagents?: (tasks: Task[]) => Promise<TaskResult[]>,
): Promise<ToolResult> {
  const tool = createParallelReviewTool(onRunSubagents)
  return tool.execute("t1", args, undefined, undefined, undefined)
}

describe("runner fallback", () => {
  it("refuses honestly instead of rubber-stamping APPROVE", async () => {
    const res = await run({ diff: DIFF, files: ["db.ts"] })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("no subagent runner is configured")
    expect(firstText(res)).toContain("nothing was actually reviewed")
    expect(firstText(res)).not.toContain("Verdict: **APPROVE**")
  })
})

describe("argument coercion", () => {
  it("treats a single files string like a one-element array", async () => {
    const seen: string[][] = []
    const capture = async (tasks: Task[]): Promise<TaskResult[]> => {
      seen.push(tasks.map((t) => t.name))
      return []
    }
    await run({ diff: DIFF, files: "db.ts" }, capture)
    await run({ diff: DIFF, files: ["db.ts"] }, capture)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual(seen[1])
  })

  it("rejects a non-string diff instead of throwing on .trim()", async () => {
    const res = await run({ diff: 42 }, async () => [])
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Missing or empty 'diff' parameter.")
  })

  it("rejects an empty diff", async () => {
    const res = await run({ diff: "  " }, async () => [])
    expect(res.isError).toBe(true)
    expect(firstText(res)).toBe("Missing or empty 'diff' parameter.")
  })
})

describe("verification barrier (fail closed)", () => {
  it("blocks on a confirmed CRITICAL finding", async () => {
    const runner = async (tasks: Task[]): Promise<TaskResult[]> =>
      tasks[0]?.name.startsWith("verify_")
        ? tasks.map((t) => ({ name: t.name, text: "CONFIRMED: concat reaches db.execute unsanitized" }))
        : [{ name: "security-reviewer", text: CRITICAL_JSON }]
    const res = await run({ diff: DIFF, files: ["db.ts"] }, runner)
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("Verdict: **CHANGES_REQUESTED**")
    expect(text).toContain("SQL injection in query builder")
    expect(text).toContain("Blocking Findings (1)")
  })

  it("moves a refuted finding to advisory and approves", async () => {
    const runner = async (tasks: Task[]): Promise<TaskResult[]> =>
      tasks[0]?.name.startsWith("verify_")
        ? tasks.map((t) => ({ name: t.name, text: "REFUTED: input is allow-list validated two lines above" }))
        : [{ name: "security-reviewer", text: CRITICAL_JSON }]
    const res = await run({ diff: DIFF, files: ["db.ts"] }, runner)
    const text = firstText(res)
    expect(text).toContain("Verdict: **APPROVE**")
    expect(text).toContain("Refuted by skeptic verifier")
  })

  it("blocks when a review dimension fails", async () => {
    const runner = async (tasks: Task[]): Promise<TaskResult[]> =>
      tasks.map((t) => ({ name: t.name, text: "", error: "runner exploded" }))
    const res = await run({ diff: DIFF, files: ["db.ts"] }, runner)
    const text = firstText(res)
    expect(text).toContain("Verdict: **CHANGES_REQUESTED**")
    expect(text).toContain("Failed Review Dimensions")
    expect(text).toContain("runner exploded")
  })
})

describe("verify wave bound (#113)", () => {
  it("caps adversarial verifiers at 16 and leaves the rest unverified-blocking", async () => {
    // A reviewer's model output is steerable by the reviewed diff: flood the
    // parse with 40 unique CRITICAL findings and the verify wave must NOT
    // spawn 40 nested runs from one tool call. Old code: seen = [40].
    const flood = JSON.stringify({
      findings: Array.from({ length: 40 }, (_, i) => ({
        title: `blocker ${i}`,
        severity: "CRITICAL",
        file: `f${i}.ts`,
        evidence: `evidence ${i}`,
      })),
    })
    const seen: number[] = []
    const runner = async (tasks: Task[]): Promise<TaskResult[]> => {
      if (tasks[0]?.name.startsWith("verify_")) {
        seen.push(tasks.length)
        return tasks.map((t) => ({ name: t.name, text: "CONFIRMED: real" }))
      }
      return [{ name: "security-reviewer", text: flood }]
    }
    const res = await run({ diff: DIFF, files: ["db.ts"] }, runner)
    expect(res.isError).toBe(false)
    // Bounded fan-out…
    expect(seen).toEqual([16])
    // …and the 24 skipped blockers stay blocking (fail closed), surfaced in
    // the report rather than silently dropped.
    const text = firstText(res)
    expect(text).toContain("Verification capped")
    expect(text).toContain("Unverified: 24")
    expect(text).toContain("Verdict: **CHANGES_REQUESTED**")
  })
})
