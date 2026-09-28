/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import * as fs from "fs"
import path from "path"
import * as os from "os"

import { runSubprocess, runPython, runShell } from "./subprocess.js"
import { initScratchpad, updateScratchpad, appendAssumption, appendError, clearScratchpad } from "./scratchpad.js"
import { initJournal, logHealingEntry, getPreventionRules, type JournalEntry } from "./journal.js"
import { RollbackController } from "./rollback.js"
import { validatePatch, extractPythonScope, extractTypeScriptScope } from "./ast-validator.js"
import { verifyPythonCompile, verifyTypeScript } from "./verify.js"
import { HealingController, type HealingContext } from "./healing-controller.js"

// Subprocess verification (tsc / python cold start, plus antivirus scanning
// freshly written fixture files) routinely exceeds vitest's 5s default on
// loaded Windows machines — give it real headroom.
vi.setConfig({ testTimeout: 30_000 })

const tmpRoot = path.join(os.tmpdir(), `trayambak-healing-test-${Date.now()}`)

function ensureTmpDir(): void {
  if (!fs.existsSync(tmpRoot)) fs.mkdirSync(tmpRoot, { recursive: true })
}

function cleanupTmpDir(): void {
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true })
}

beforeAll(() => {
  ensureTmpDir()
  process.chdir(tmpRoot)
})

afterAll(() => {
  process.chdir(__dirname)
  cleanupTmpDir()
})

describe("Healing Framework: subprocess", () => {
  it("runs a simple echo command", async () => {
    const result = await runSubprocess("node", ["-e", "console.log('hello')"], { timeoutMs: 5000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("hello")
    expect(result.timedOut).toBe(false)
  })

  it("respects timeout", async () => {
    const result = await runSubprocess("node", ["-e", "await new Promise(r => setTimeout(r, 200))"], { timeoutMs: 50 })
    expect(result.timedOut).toBe(true)
  })

  it("runPython writes and executes a script", async () => {
    const result = await runPython("print('python-ok')", [], { timeoutMs: 5000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("python-ok")
  })

  it("runShell executes a shell command", async () => {
    const result = await runShell("echo shell-output", { timeoutMs: 5000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("shell-output")
  })

  it("rejects non-existent commands", async () => {
    await expect(runSubprocess("nonexistent-command-xyz", [], { timeoutMs: 1000 })).rejects.toThrow()
  })
})

describe("Healing Framework: scratchpad", () => {
  beforeAll(() => {
    ensureTmpDir()
    process.chdir(tmpRoot)
  })

  it("initializes and writes scratchpad file", () => {
    initScratchpad()
    expect(fs.existsSync(path.join(tmpRoot, ".trayambak", "agent_scratchpad.md"))).toBe(true)
  })

  it("appends assumptions", () => {
    appendAssumption("test assumption: the bug is in the healing module")
    const content = fs.readFileSync(path.join(tmpRoot, ".trayambak", "agent_scratchpad.md"), "utf8")
    expect(content).toContain("test assumption: the bug is in the healing module")
  })

  it("appends errors", () => {
    appendError("test error: patch failed validation")
    const content = fs.readFileSync(path.join(tmpRoot, ".trayambak", "agent_scratchpad.md"), "utf8")
    expect(content).toContain("test error: patch failed validation")
  })

  it("updates scratchpad with full entry", () => {
    updateScratchpad({
      goal: "Test healing goal",
      targetType: "USER_CODE",
      knownFacts: ["fact 1"],
      activeErrors: ["error 1"],
      invalidAssumptions: [],
      proposedPatch: "const x = 1",
      timestamp: new Date().toISOString(),
      status: "active",
    })
    const content = fs.readFileSync(path.join(tmpRoot, ".trayambak", "agent_scratchpad.md"), "utf8")
    expect(content).toContain("Test healing goal")
    expect(content).toContain("fact 1")
    expect(content).toContain("const x = 1")
  })

  it("clears scratchpad on reset", () => {
    clearScratchpad()
    const content = fs.readFileSync(path.join(tmpRoot, ".trayambak", "agent_scratchpad.md"), "utf8")
    expect(content).toContain("No active tasks")
  })
})

describe("Healing Framework: journal", () => {
  beforeAll(() => {
    ensureTmpDir()
    process.chdir(tmpRoot)
  })

  it("initializes and writes journal file", () => {
    initJournal()
    expect(fs.existsSync(path.join(tmpRoot, ".trayambak", "self_healing_journal.md"))).toBe(true)
  })

  it("logs a healing entry", () => {
    const entry: JournalEntry = {
      bugId: "BUG-TEST-001",
      targetType: "USER_CODE",
      rootCause: "Test root cause",
      verifiedPatch: "const fixed = true",
      preventionRule: "Validate all patches before writing",
      timestamp: new Date().toISOString(),
      filePath: "test-file.ts",
      lineNumber: 10,
    }
    logHealingEntry(entry)
    const content = fs.readFileSync(path.join(tmpRoot, ".trayambak", "self_healing_journal.md"), "utf8")
    expect(content).toContain("BUG-TEST-001")
    expect(content).toContain("Test root cause")
    expect(content).toContain("Validate all patches before writing")
  })

  it("retrieves prevention rules", () => {
    const rules = getPreventionRules()
    expect(rules.length).toBeGreaterThan(0)
    expect(rules[0]).toContain("Validate all patches before writing")
  })
})

describe("Healing Framework: rollback", () => {
  it("captures and restores a snapshot", () => {
    ensureTmpDir()
    const testFile = path.join(tmpRoot, "test-file.ts")
    const originalContent = "// original content\nconst x = 1;\n"
    fs.writeFileSync(testFile, originalContent, "utf8")

    const rollback = new RollbackController(tmpRoot)
    const snapshotId = rollback.captureSnapshot(["test-file.ts"], "test snapshot")

    const modifiedContent = "// modified content\nconst y = 2;\n"
    fs.writeFileSync(testFile, modifiedContent, "utf8")
    expect(fs.readFileSync(testFile, "utf8")).toBe(modifiedContent)

    const restored = rollback.restoreSnapshot(snapshotId)
    expect(restored).toBe(true)
    expect(fs.readFileSync(testFile, "utf8")).toBe(originalContent)
  })

  it("handles non-existent files in snapshot", () => {
    ensureTmpDir()
    const rollback = new RollbackController(tmpRoot)
    const snapshotId = rollback.captureSnapshot(["nonexistent.ts"], "missing file snapshot")
    expect(snapshotId).toBeTruthy()

    const restored = rollback.restoreSnapshot(snapshotId)
    expect(restored).toBe(true)
  })
})

describe("Healing Framework: ast-validator", () => {
  it("extracts Python scope correctly", () => {
    const source = `# test
import os
from sys import argv

def my_function(x):
    return x + 1

y = my_function(42)
`
    const scope = extractPythonScope(source)
    expect(scope.variables.has("y")).toBe(true)
    expect(scope.variables.has("x")).toBe(true)
    expect(scope.functions.has("my_function")).toBe(true)
    expect(scope.imports.has("argv")).toBe(true)
    expect(scope.imports.has("os")).toBe(true)
  })

  it("extracts TypeScript scope correctly", () => {
    const source = `import { test } from "vitest";
import type { Foo } from "./types.js"

const MY_CONST = 42;
let mutable = "hello";

function myFunc(): void {}
const arrow = (x: number) => x * 2;
`
    const scope = extractTypeScriptScope(source)
    expect(scope.variables.has("MY_CONST")).toBe(true)
    expect(scope.variables.has("mutable")).toBe(true)
    expect(scope.functions.has("myFunc")).toBe(true)
    expect(scope.functions.has("arrow")).toBe(true)
    expect(scope.imports.has("test")).toBe(true)
  })

  it("validates a valid TypeScript patch", () => {
    const original = `const x = 1;
function foo() { return x; }
`
    const patched = `const x = 1;
function foo() { return x + 1; }
`
    const result = validatePatch(original, patched, "typescript")
    expect(result.valid).toBe(true)
    expect(result.newVariablesIntroduced).toHaveLength(0)
    expect(result.newFunctions).toHaveLength(0)
  })

  it("detects new variables in a patch", () => {
    const original = `const x = 1;
`
    const patched = `const x = 1;
const y = 2;
`
    const result = validatePatch(original, patched, "typescript")
    expect(result.valid).toBe(false)
    expect(result.newVariablesIntroduced).toContain("y")
  })
})

describe("Healing Framework: verify", () => {
  it("verifies Python compile", async () => {
    ensureTmpDir()
    const testFile = path.join(tmpRoot, "valid-test.py")
    fs.writeFileSync(testFile, "def hello():\n    return 'world'\n", "utf8")
    const result = await verifyPythonCompile(testFile, tmpRoot)
    expect(result.passed).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("detects Python syntax errors", async () => {
    ensureTmpDir()
    const testFile = path.join(tmpRoot, "invalid-test.py")
    fs.writeFileSync(testFile, "def hello(:\n    return 'world'\n", "utf8")
    const result = await verifyPythonCompile(testFile, tmpRoot)
    expect(result.passed).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("verifies TypeScript", async () => {
    ensureTmpDir()
    const testFile = path.join(tmpRoot, "valid-test.ts")
    fs.writeFileSync(testFile, "const x: number = 42;\n", "utf8")
    const result = await verifyTypeScript(testFile, tmpRoot)
    expect(result.passed).toBe(true)
  })
})

describe("Healing Framework: HealingController integration", () => {
  it("successfully heals a file with a valid patch", async () => {
    ensureTmpDir()
    const testFile = path.join(tmpRoot, "heal-target.ts")
    const originalContent = "const x = 1;\nconsole.log(x);\n"
    fs.writeFileSync(testFile, originalContent, "utf8")

    const controller = new HealingController(tmpRoot)

    let patchCallCount = 0
    const ctx: HealingContext = {
      originalError: "Variable x should be 2",
      errorLocation: "heal-target.ts:0",
      fileToFix: "heal-target.ts",
      language: "typescript",
      originalSource: originalContent,
      patches: [],
      assumptions: ["x is incorrectly set to 1"],
    }

    const result = await controller.heal(ctx, async () => {
      patchCallCount++
      return {
        type: "edit" as const,
        filePath: "heal-target.ts",
        oldContent: "const x = 1;",
        newContent: "const x = 2;",
      }
    })

    expect(result.success).toBe(true)
    expect(result.patch).not.toBeNull()
    expect(patchCallCount).toBe(1)
    expect(fs.readFileSync(testFile, "utf8")).toContain("const x = 2;")
  })

  it("rolls back and fails when patch produces invalid code", async () => {
    ensureTmpDir()
    const testFile = path.join(tmpRoot, "heal-fail.ts")
    const originalContent = "const x = 1;\n"
    fs.writeFileSync(testFile, originalContent, "utf8")

    const controller = new HealingController(tmpRoot)

    const ctx: HealingContext = {
      originalError: "Syntax error",
      errorLocation: "heal-fail.ts:0",
      fileToFix: "heal-fail.ts",
      language: "typescript",
      originalSource: originalContent,
      patches: [],
      assumptions: [],
    }

    const result = await controller.heal(ctx, async () => {
      return {
        type: "create" as const,
        filePath: "heal-fail.ts",
        newContent: "const y = 2;\nfunction broken(: {\n",
      }
    })

    expect(result.success).toBe(false)
    expect(fs.readFileSync(testFile, "utf8")).toBe(originalContent)
  })
})
