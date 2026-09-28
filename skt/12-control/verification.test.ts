/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { VerificationPipeline } from "./verification.js"

const OK = 'node -e "process.exit(0)"'
const FAIL = 'node -e "process.exit(1)"'
const SLOW = 'node -e "setTimeout(()=>{},3000)"'

let tmp = ""

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-verify-"))
})

afterEach(async () => {
  // The timed-out test leaves an orphaned node process whose cwd is tmp;
  // Windows refuses to delete a directory in use, so retry until it exits.
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
      return
    } catch (e) {
      if (Date.now() >= deadline) throw e
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
})

const writePkg = (scripts: Record<string, string>): void => {
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "verify-fixture", version: "1.0.0", scripts }),
    "utf8",
  )
}

describe("VerificationPipeline", () => {
  it("runs a configured script and reports a passing run", async () => {
    writePkg({ test: OK })
    const report = await new VerificationPipeline({ cwd: tmp, steps: ["unit_test"] }).run()
    expect(report.overall).toBe("pass")
    expect(report.steps.length).toBe(1)
    expect(report.steps[0]?.step).toBe("unit_test")
    expect(report.steps[0]?.status).toBe("pass")
    expect(report.summary).toBe("1 passed, 0 failed, 0 errors, 0 skipped")
    expect(report.duration_ms).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it("marks a failing script as an error and the run as failed", async () => {
    writePkg({ test: FAIL })
    const report = await new VerificationPipeline({ cwd: tmp, steps: ["unit_test"] }).run()
    expect(report.overall).toBe("fail")
    expect(report.steps[0]?.status).toBe("error")
    expect(report.steps[0]?.error).toContain("Command failed")
    expect(report.summary).toBe("0 passed, 0 failed, 1 errors, 0 skipped")
  }, 60_000)

  it("keeps running later steps after an error (nothing ever reports status fail)", async () => {
    writePkg({ test: FAIL })
    const report = await new VerificationPipeline({
      cwd: tmp,
      steps: ["unit_test", "diff_review"],
    }).run()
    expect(report.steps.length).toBe(2)
    expect(report.steps.every((s) => s.status === "error")).toBe(true)
    expect(report.overall).toBe("fail")
  }, 60_000)

  it("treats steps with no configured command as passes", async () => {
    // No package.json at all: unit_test/build/integration/runtime resolve to nothing.
    const report = await new VerificationPipeline({
      cwd: tmp,
      steps: ["unit_test", "build", "integration_test", "runtime_test"],
    }).run()
    expect(report.steps.every((s) => s.status === "pass")).toBe(true)
    expect(report.steps.every((s) => s.output === "skipped (no command configured)")).toBe(true)
    expect(report.overall).toBe("pass")
    expect(report.summary).toBe("4 passed, 0 failed, 0 errors, 0 skipped")
  }, 60_000)

  it("treats an unparsable package.json as having no scripts", async () => {
    fs.writeFileSync(path.join(tmp, "package.json"), "{ not json", "utf8")
    const report = await new VerificationPipeline({ cwd: tmp, steps: ["unit_test"] }).run()
    expect(report.steps[0]?.status).toBe("pass")
    expect(report.steps[0]?.output).toBe("skipped (no command configured)")
  }, 60_000)

  it("prefers test:unit when no test script exists", async () => {
    writePkg({ "test:unit": OK })
    const report = await new VerificationPipeline({ cwd: tmp, steps: ["unit_test"] }).run()
    expect(report.steps[0]?.status).toBe("pass")
    expect(report.overall).toBe("pass")
  }, 60_000)

  it("runs format, lint, and typecheck scripts when present", async () => {
    writePkg({ format: OK, lint: OK, typecheck: OK })
    const report = await new VerificationPipeline({
      cwd: tmp,
      steps: ["format", "lint", "typecheck"],
    }).run()
    expect(report.steps.map((s) => s.step)).toEqual(["format", "lint", "typecheck"])
    expect(report.steps.every((s) => s.status === "pass")).toBe(true)
    expect(report.summary).toBe("3 passed, 0 failed, 0 errors, 0 skipped")
  }, 60_000)

  it("runs integration, build, and runtime scripts when present", async () => {
    writePkg({ "test:integration": OK, build: OK, "test:runtime": OK })
    const report = await new VerificationPipeline({
      cwd: tmp,
      steps: ["integration_test", "build", "runtime_test"],
    }).run()
    expect(report.steps.every((s) => s.status === "pass")).toBe(true)
    expect(report.summary).toBe("3 passed, 0 failed, 0 errors, 0 skipped")
  }, 60_000)

  it("records a timeout error when a command exceeds timeout_ms", async () => {
    writePkg({ test: SLOW })
    const report = await new VerificationPipeline({
      cwd: tmp,
      steps: ["unit_test"],
      timeout_ms: 1_000,
    }).run()
    expect(report.steps[0]?.status).toBe("error")
    expect(report.steps[0]?.error).toBe("Command timed out")
    expect(report.overall).toBe("fail")
  }, 60_000)
})
