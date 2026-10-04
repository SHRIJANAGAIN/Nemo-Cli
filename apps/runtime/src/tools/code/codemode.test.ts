/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { createCodemodeTool, runCodemode } from "./codemode.js"

function bodyOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join()
}

describe("runCodemode", () => {
  it("evaluates expressions and returns JSON", () => {
    expect(runCodemode("1 + 2")).toMatchObject({ ok: true, result: "3", error: "" })
    expect(runCodemode("[...new Set([1,1,2])].length")).toMatchObject({ ok: true, result: "2" })
    expect(runCodemode("({a:1})")).toMatchObject({ ok: true, result: '{"a":1}' })
  })

  it("passes input and captures console output", () => {
    const outcome = runCodemode('console.log("seen", 1 + 1); input.length', { input: "hello" })

    expect(outcome.ok).toBe(true)
    expect(outcome.logs).toEqual(["seen 2"])
    expect(outcome.result).toBe("5")
  })

  it("blocks host access with ReferenceError, not host damage", () => {
    for (const name of ["process", "require", "fetch", "setTimeout", "clearTimeout"]) {
      const outcome = runCodemode(`typeof ${name} === "undefined" ? "blocked" : "LEAK"`)
      // The probe expression itself must evaluate without reaching the host.
      expect(outcome.ok).toBe(true)
      expect(outcome.result).toBe('"blocked"')
    }
    // The sandbox global exists but carries no host handles.
    expect(runCodemode('typeof globalThis.process === "undefined" ? "blocked" : "LEAK"')).toMatchObject({
      ok: true,
      result: '"blocked"',
    })
    // Direct touch throws instead of escaping.
    expect(runCodemode("process.cwd()").ok).toBe(false)
    expect(runCodemode("process.cwd()").error).toContain("process is not defined")
  })

  it("stops infinite loops at the timeout", () => {
    const outcome = runCodemode("while (true) {}", { timeoutMs: 200 })

    expect(outcome.ok).toBe(false)
    expect(outcome.error.toLowerCase()).toContain("timed out")
  })

  it("reports syntax errors as errors, not crashes", () => {
    const outcome = runCodemode("function broken( {")

    expect(outcome.ok).toBe(false)
    expect(outcome.error.length).toBeGreaterThan(0)
  })

  it("rejects async completion values loudly", () => {
    const outcome = runCodemode("(async () => 1)()")

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain("async results are not supported")
  })

  it("truncates huge results", () => {
    const outcome = runCodemode("'x'.repeat(9000)")

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toContain("[truncated]")
    expect(outcome.result.length).toBeLessThan(5000)
  })

  it("caps console retention on log-spam loops and says what was dropped", () => {
    const outcome = runCodemode('for (let i = 0; i < 5000; i++) console.log("line", i)')

    expect(outcome.ok).toBe(true)
    expect(outcome.logs.length).toBe(201) // 200 kept + overflow note
    expect(outcome.logs[0]).toBe("line 0")
    expect(outcome.logs[outcome.logs.length - 1]).toContain("more log lines dropped")
  })

  it("closes host-realm constructor escapes — no guest→host Function bridge (#114)", () => {
    // Before #114 the sandbox injected HOST builtins + host console closures:
    // `Array.constructor("return process")()` returned the host Node version.
    const vectors = [
      'Array.constructor("return process")().version',
      'String.constructor("return process")().version',
      'parseInt.constructor("return process")().version',
      'console.log.constructor("return process")().version',
      '"".constructor.constructor("return process")().version',
      'Math.random.constructor("return process")().version',
      'JSON.parse.constructor("return process")().version',
      'globalThis.constructor.constructor("return process")().version',
      'Object.getPrototypeOf(globalThis).constructor.constructor("return process")().version',
      'new Map().constructor.constructor("return process")().version',
      'encodeURIComponent.constructor("return process")().version',
    ]
    for (const code of vectors) {
      const outcome = runCodemode(code, { timeoutMs: 2000 })
      expect(outcome.ok, `escape vector survived: ${code}`).toBe(false)
      expect(outcome.result, `vector leaked host data: ${code}`).not.toMatch(/v\d+\.\d+/)
      expect(outcome.error.length, `vector died silently: ${code}`).toBeGreaterThan(0)
    }
  })

  it("keeps full guest-realm builtins without host injection (#114)", () => {
    expect(runCodemode("Math.max(1, 5)")).toMatchObject({ ok: true, result: "5" })
    expect(runCodemode('JSON.parse("[1,2,3]").length')).toMatchObject({ ok: true, result: "3" })
    expect(runCodemode('parseInt("42", 10) + 1')).toMatchObject({ ok: true, result: "43" })
    expect(runCodemode("[1,2,3].map((x) => x * 2).join(',')")).toMatchObject({ ok: true, result: '"2,4,6"' })
    expect(runCodemode('encodeURIComponent("a b")')).toMatchObject({ ok: true, result: '"a%20b"' })
    expect(runCodemode("new Date(0).getUTCFullYear()")).toMatchObject({ ok: true, result: "1970" })
    expect(runCodemode('typeof globalThis.setTimeout === "undefined" ? "blocked" : "LEAK"')).toMatchObject({
      ok: true,
      result: '"blocked"',
    })
  })
})

describe("createCodemodeTool", () => {
  it("exposes the codemode identity", () => {
    expect(createCodemodeTool().definition.name).toBe("codemode")
  })

  it("rejects missing code", async () => {
    const tool = createCodemodeTool()
    const result = await tool.execute("t1", {}, undefined, undefined, undefined as never)

    expect(result.isError).toBe(true)
  })

  it("returns logs plus the JSON result", async () => {
    const tool = createCodemodeTool()
    const result = await tool.execute(
      "t1",
      { code: 'console.log("hi"); input + "!"', input: "yo" },
      undefined,
      undefined,
      undefined as never,
    )

    expect(result.isError).toBe(false)
    expect(bodyOf(result)).toBe('hi\n---\n"yo!"')
  })

  it("surfaces confined errors as tool errors", async () => {
    const tool = createCodemodeTool()
    const result = await tool.execute("t1", { code: "process.cwd()" }, undefined, undefined, undefined as never)

    expect(result.isError).toBe(true)
    expect(bodyOf(result)).toContain("process is not defined")
  })
})
