/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { runSubprocess } from "./subprocess.js"
import path from "path"
import * as fs from "fs"

function findTscBinary(projectRoot?: string): string | null {
  const searchRoots = [projectRoot ?? process.cwd(), __dirname].filter(Boolean)
  for (const root of searchRoots) {
    let cwd = path.resolve(root)
    for (let i = 0; i < 10; i++) {
      const localTsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc")
      if (fs.existsSync(localTsc)) return localTsc
      const parent = path.dirname(cwd)
      if (parent === cwd) break
      cwd = parent
    }
  }
  return null
}

export interface VerificationResult {
  passed: boolean
  exitCode: number
  stdout: string
  stderr: string
  errors: string[]
  warnings: string[]
  timedOut: boolean
}

export async function verifyPythonCompile(filePath: string, cwd?: string): Promise<VerificationResult> {
  const result = await runSubprocess("python", ["-m", "py_compile", filePath], {
    cwd,
    timeoutMs: 30000,
  })

  const errors: string[] = []
  const warnings: string[] = []

  if (result.exitCode !== 0 && result.stderr) {
    errors.push(result.stderr.trim())
  }

  return {
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errors,
    warnings,
    timedOut: result.timedOut,
  }
}

export async function verifyTypeScript(filePath: string, projectRoot?: string): Promise<VerificationResult> {
  const cwd = projectRoot ?? process.cwd()
  const localTsc = findTscBinary(cwd)
  const cmd = localTsc ? "node" : "npx"
  const args = localTsc ? [localTsc, "--noEmit", "--strict", filePath] : ["--noEmit", "--strict", filePath]

  const result = await runSubprocess(cmd, args, { cwd, timeoutMs: 60000 })

  const errors: string[] = []
  const warnings: string[] = []

  if (result.exitCode !== 0 && result.stdout) {
    const lines = result.stdout.split("\n").filter((l) => l.trim())
    for (const line of lines) {
      if (line.includes("error TS")) {
        errors.push(line)
      } else if (line.includes("warning")) {
        warnings.push(line)
      }
    }
  }

  return {
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errors,
    warnings,
    timedOut: result.timedOut,
  }
}

export async function runTests(
  testPattern: string,
  cwd?: string,
  testRunner: "pytest" | "jest" | "bun" = "pytest",
): Promise<VerificationResult> {
  let cmd: string
  let args: string[]

  if (testRunner === "pytest") {
    cmd = "python"
    args = ["-m", "pytest", testPattern, "--tb=short", "-v"]
  } else if (testRunner === "jest") {
    cmd = "npx"
    args = ["jest", testPattern, "--silent"]
  } else {
    cmd = "bun"
    args = ["test", testPattern]
  }

  const result = await runSubprocess(cmd, args, { cwd, timeoutMs: 120000 })

  const errors: string[] = []
  const warnings: string[] = []

  const output = result.stdout + result.stderr
  if (/FAILED|✕|ERROR|✖/.test(output)) {
    const failedLines = output.split("\n").filter((line) => /FAILED|✕|ERROR|✖/.test(line))
    errors.push(...failedLines)
  }

  if (/WARN|⚠|deprecat/i.test(output)) {
    const warnLines = output.split("\n").filter((line) => /WARN|⚠|deprecat/i.test(line))
    warnings.push(...warnLines)
  }

  return {
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errors,
    warnings,
    timedOut: result.timedOut,
  }
}

export async function runLint(filePath: string, language: "python" | "typescript"): Promise<VerificationResult> {
  if (language === "python") {
    const result = await runSubprocess("python", ["-m", "py_compile", filePath], {
      timeoutMs: 15000,
    })
    return {
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      errors: result.exitCode === 0 ? [] : [result.stderr.trim()],
      warnings: [],
      timedOut: result.timedOut,
    }
  }

  const localTsc = findTscBinary(process.cwd())
  const cmd = localTsc ? "node" : "npx"
  const args = localTsc
    ? [localTsc, "--noEmit", "--noImplicitAny", filePath]
    : ["--noEmit", "--noImplicitAny", filePath]

  const result = await runSubprocess(cmd, args, { timeoutMs: 30000 })

  return {
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errors: result.exitCode === 0 ? [] : [result.stdout, result.stderr].filter(Boolean),
    warnings: [],
    timedOut: result.timedOut,
  }
}

export async function runCustomCheck(
  command: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<VerificationResult> {
  const result = await runSubprocess(command, args, opts)
  return {
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errors: result.exitCode === 0 ? [] : [result.stderr.trim()],
    warnings: [],
    timedOut: result.timedOut,
  }
}
