/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Execution-Based Verification Pipeline.
 * GENERATE → FORMAT → LINT → TYPECHECK → UNIT TEST → INTEGRATION TEST → BUILD → RUNTIME TEST → DIFF REVIEW → FINAL
 */

import { execSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

export type VerificationStep =
  "format" | "lint" | "typecheck" | "unit_test" | "integration_test" | "build" | "runtime_test" | "diff_review"

export interface StepResult {
  step: VerificationStep
  status: "pass" | "fail" | "skip" | "error"
  duration_ms: number
  output: string
  error?: string
}

export interface VerificationReport {
  steps: StepResult[]
  overall: "pass" | "fail" | "skip"
  duration_ms: number
  summary: string
}

export interface VerificationConfig {
  cwd: string
  steps: VerificationStep[]
  timeout_ms: number
  stopOnFirstFail: boolean
}

const DEFAULT_STEPS: VerificationStep[] = ["format", "lint", "typecheck", "unit_test", "build"]

export class VerificationPipeline {
  private config: VerificationConfig

  constructor(config: Partial<VerificationConfig> & { cwd: string }) {
    this.config = {
      steps: DEFAULT_STEPS,
      timeout_ms: 120_000,
      stopOnFirstFail: true,
      ...config,
    }
  }

  /**
   * Run the full verification pipeline.
   */
  async run(): Promise<VerificationReport> {
    const t0 = Date.now()
    const results: StepResult[] = []

    for (const step of this.config.steps) {
      const result = await this.runStep(step)
      results.push(result)

      if (this.config.stopOnFirstFail && result.status === "fail") {
        break
      }
    }

    const failed = results.filter((r) => r.status === "fail" || r.status === "error")
    const overall = failed.length > 0 ? "fail" : "pass"

    return {
      steps: results,
      overall,
      duration_ms: Date.now() - t0,
      summary: this.generateSummary(results),
    }
  }

  /**
   * Run a single verification step.
   */
  private async runStep(step: VerificationStep): Promise<StepResult> {
    const t0 = Date.now()
    try {
      const output = await this.executeCommand(step)
      return {
        step,
        status: "pass",
        duration_ms: Date.now() - t0,
        output,
      }
    } catch (err: any) {
      const isTimeout = err.killed || err.code === "ETIMEDOUT"
      return {
        step,
        status: "error",
        duration_ms: Date.now() - t0,
        output: err.stdout?.toString() || "",
        error: isTimeout ? "Command timed out" : err.message,
      }
    }
  }

  /**
   * Execute the command for a verification step.
   */
  private async executeCommand(step: VerificationStep): Promise<string> {
    const pkgPath = path.join(this.config.cwd, "package.json")
    const hasPkg = fs.existsSync(pkgPath)
    let scripts: Record<string, string> = {}

    if (hasPkg) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
        scripts = pkg.scripts || {}
      } catch {
        /* ignore */
      }
    }

    let command: string | null = null

    switch (step) {
      case "format":
        if (scripts.format) command = "npm run format"
        else if (this.hasBinary("prettier")) command = "npx prettier --check ."
        break
      case "lint":
        if (scripts.lint) command = "npm run lint"
        else if (this.hasBinary("eslint")) command = "npx eslint ."
        break
      case "typecheck":
        if (scripts.typecheck) command = "npm run typecheck"
        else if (this.hasBinary("tsc")) command = "npx tsc --noEmit"
        break
      case "unit_test":
        if (scripts.test) command = "npm test"
        else if (scripts["test:unit"]) command = "npm run test:unit"
        break
      case "integration_test":
        if (scripts["test:integration"]) command = "npm run test:integration"
        break
      case "build":
        if (scripts.build) command = "npm run build"
        break
      case "runtime_test":
        if (scripts["test:runtime"]) command = "npm run test:runtime"
        break
      case "diff_review":
        command = "git diff --stat"
        break
    }

    if (!command) {
      return "skipped (no command configured)"
    }

    const output = execSync(command, {
      cwd: this.config.cwd,
      stdio: "pipe",
      timeout: this.config.timeout_ms,
      encoding: "utf8",
    })

    return output.slice(0, 500)
  }

  private hasBinary(name: string): boolean {
    try {
      execSync(`npx ${name} --version`, { cwd: this.config.cwd, stdio: "pipe", timeout: 10_000 })
      return true
    } catch {
      return false
    }
  }

  private generateSummary(results: StepResult[]): string {
    const passed = results.filter((r) => r.status === "pass").length
    const failed = results.filter((r) => r.status === "fail").length
    const errors = results.filter((r) => r.status === "error").length
    const skipped = results.filter((r) => r.status === "skip").length
    return `${passed} passed, ${failed} failed, ${errors} errors, ${skipped} skipped`
  }
}
