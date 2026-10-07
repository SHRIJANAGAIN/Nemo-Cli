/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import {
  createRunWorkflowTool,
  executeWorkflow,
  executeWorkflowResumed,
  loadWorkflowRun,
  saveWorkflowRun,
  stepHash,
  validateWorkflow,
  type WorkflowDefinition,
} from "./workflow.js"
import type { ToolContext } from "../types.js"

const ctx = { cwd: process.cwd() } as unknown as ToolContext

function def(): WorkflowDefinition {
  return {
    name: "audit",
    description: "lint audit",
    steps: [
      { id: "lint", action: "run lint" },
      { id: "test", action: "run tests" },
    ],
  }
}

function tmpCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-flow-"))
  return dir
}

describe("validateWorkflow", () => {
  it("rejects empty and oversized definitions", () => {
    expect(validateWorkflow({ name: "", description: "", steps: [] }).length).toBeGreaterThan(0)
    const big = def()
    big.steps = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, action: "x" }))
    expect(validateWorkflow(big).some((e) => e.includes("exceed"))).toBe(true)
  })

  it("rejects duplicate step ids", () => {
    const d = def()
    d.steps = [
      { id: "a", action: "x" },
      { id: "a", action: "y" },
    ]
    expect(validateWorkflow(d).some((e) => e.includes("Duplicate"))).toBe(true)
  })

  it("reports missing steps as a validation error instead of crashing", () => {
    // validateWorkflow read `def.steps.length` AFTER the Array.isArray miss had
    // already pushed its error — a JSON workflow without `steps` threw a
    // TypeError out of the tool instead of returning the validation report.
    const errors = validateWorkflow({ name: "x", description: "y" } as WorkflowDefinition)
    expect(errors.some((e) => e.includes("at least one step"))).toBe(true)
  })
})

describe("executeWorkflow (steps-less definition)", () => {
  it("does not crash on a definition missing steps", () => {
    const res = executeWorkflow({ name: "x", description: "y" } as WorkflowDefinition, { prompt: "" })
    expect(res.results).toHaveLength(0)
  })

  it("does not crash in the resumed executor either", () => {
    const res = executeWorkflowResumed({ name: "x", description: "y" } as WorkflowDefinition, { prompt: "" })
    expect(res.results).toHaveLength(0)
    expect(res.reused).toBe(0)
  })
})

describe("stepHash", () => {
  it("is stable and content-sensitive", () => {
    const a = { id: "s", action: "lint" }
    expect(stepHash(a)).toBe(stepHash({ id: "s", action: "lint" }))
    expect(stepHash(a)).not.toBe(stepHash({ id: "s", action: "test" }))
  })
})

describe("executeWorkflowResumed", () => {
  it("reuses identical prefix steps and reruns edited ones", () => {
    const first = executeWorkflowResumed(def(), { prompt: "" })
    expect(first.reused).toBe(0)
    const record = {
      runId: "r1",
      name: "audit",
      at: new Date().toISOString(),
      steps: first.results.map((r, i) => ({
        stepId: r.stepId,
        hash: stepHash(def().steps[i] as never),
        output: r.output,
      })),
    }
    const edited = def()
    edited.steps[1] = { id: "test", action: "run tests with coverage" }
    const second = executeWorkflowResumed(edited, { prompt: "", resumeFrom: record })
    expect(second.reused).toBe(1)
    expect(second.results[0]?.output).toBe(first.results[0]?.output)
    expect(second.results[1]?.output).not.toBe(first.results[1]?.output)
  })

  it("does not reuse when the first step changed", () => {
    const first = executeWorkflowResumed(def(), { prompt: "" })
    const record = {
      runId: "r1",
      name: "audit",
      at: new Date().toISOString(),
      steps: first.results.map((r, i) => ({
        stepId: r.stepId,
        hash: stepHash(def().steps[i] as never),
        output: r.output,
      })),
    }
    const edited = def()
    edited.steps[0] = { id: "lint", action: "run lint strictly" }
    const second = executeWorkflowResumed(edited, { prompt: "", resumeFrom: record })
    expect(second.reused).toBe(0)
  })
})

describe("workflow run persistence", () => {
  it("round-trips through the runs dir and rejects traversal ids", () => {
    const cwd = tmpCwd()
    saveWorkflowRun(cwd, { runId: "run-1", name: "audit", at: "t", steps: [] })
    expect(loadWorkflowRun(cwd, "run-1")?.name).toBe("audit")
    expect(loadWorkflowRun(cwd, "../evil")).toBeUndefined()
    expect(loadWorkflowRun(cwd, "missing")).toBeUndefined()
  })
})

describe("createRunWorkflowTool", () => {
  it("exposes timeoutMs and runs with resume", async () => {
    const tool = createRunWorkflowTool()
    expect(tool.definition.timeoutMs).toBe(30_000)
    const cwd = tmpCwd()
    const c = { cwd } as unknown as ToolContext
    const d = def()
    const first = await tool.execute("t1", { workflow: JSON.stringify(d) }, undefined, undefined, c)
    expect(first.isError).toBe(false)
    const runId = fs.readdirSync(path.join(cwd, ".trayambak", "workflow-runs"))[0]?.replace(/\.json$/, "") ?? ""
    expect(runId.length).toBeGreaterThan(0)
    const second = await tool.execute(
      "t1",
      { workflow: JSON.stringify(d), resumeFromRunId: runId },
      undefined,
      undefined,
      c,
    )
    expect(second.isError).toBe(false)
    expect(second.content.map((x) => x.text ?? "").join()).toContain("reused 2")
    void ctx
  })

  it("errors honestly on unknown resume id and bad json", async () => {
    const tool = createRunWorkflowTool()
    const cwd = tmpCwd()
    const c = { cwd } as unknown as ToolContext
    const bad = await tool.execute("t1", { workflow: "nope" }, undefined, undefined, c)
    expect(bad.isError).toBe(true)
    const missing = await tool.execute(
      "t1",
      { workflow: JSON.stringify(def()), resumeFromRunId: "no-such-run" },
      undefined,
      undefined,
      c,
    )
    expect(missing.isError).toBe(true)
  })

  it("labels output as a plan and states steps are not executed", async () => {
    const cwd = tmpCwd()
    try {
      const tool = createRunWorkflowTool()
      const c = { cwd } as unknown as ToolContext
      const res = await tool.execute(
        "t1",
        { workflow: JSON.stringify({ name: "honest", description: "d", steps: [{ id: "s1", action: "build" }] }) },
        undefined,
        undefined,
        c,
      )
      expect(tool.definition.description).toContain("does NOT execute steps")
      const body = res.content.map((x) => x.text ?? "").join()
      expect(body).toContain("does not execute steps")
      expect(body).not.toContain("completed successfully")
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
