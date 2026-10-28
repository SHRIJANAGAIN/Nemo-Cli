/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The integration tests spawn the real tsc binary; Windows Defender and AV
// scanning make subprocess startup slow enough to flake under the default
// timeout (same healing pattern as the custom-tools loader tests).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

import type { ToolContext } from "../types.js"
import { collectDiagnostics, createDiagnosticsTool, resetDiagnosticsCache, resolveTscBin, TSC_TIMEOUT_MS } from "./diagnostics-tool.js"
import {
  DIAGNOSTICS_MAX_PER_FILE,
  diagnosticsPathKey,
  filterDiagnostics,
  findUp,
  isCheckableFile,
  parseTscOutput,
  pickFiles,
  pretty,
  report,
  syntaxDiagnostics,
  syntaxNote,
} from "./tsc-diagnostics.js"

function resultText(result: { content: unknown[] }): string {
  return JSON.stringify(result.content)
}

describe("pretty", () => {
  it("renders Shrijan's `ERROR [line:col] message` with 1-based positions", () => {
    expect(pretty({ range: { start: { line: 11, character: 4 } }, severity: 1, message: "TS2345: bad arg" })).toBe(
      "ERROR [12:5] TS2345: bad arg",
    )
  })

  it("maps severities and defaults to ERROR when severity is absent", () => {
    expect(pretty({ range: { start: { line: 0, character: 0 } }, severity: 2, message: "unused" })).toBe(
      "WARN [1:1] unused",
    )
    expect(pretty({ range: { start: { line: 0, character: 0 } }, message: "gone" })).toBe("ERROR [1:1] gone")
  })
})

describe("report", () => {
  it("returns '' for a clean file and for warnings-only files", () => {
    expect(report("a.ts", [])).toBe("")
    expect(report("a.ts", [{ range: { start: { line: 0, character: 0 } }, severity: 2, message: "warn" }])).toBe("")
  })

  it("wraps errors in the <diagnostics> block", () => {
    const block = report("src/a.ts", [
      { range: { start: { line: 2, character: 6 } }, severity: 1, message: "TS2345: nope" },
    ])
    expect(block).toBe('<diagnostics file="src/a.ts">\nERROR [3:7] TS2345: nope\n</diagnostics>')
  })

  it(`caps at ${DIAGNOSTICS_MAX_PER_FILE} errors with a "... and N more" suffix`, () => {
    const issues = Array.from({ length: 25 }, (_, i) => ({
      range: { start: { line: i, character: 0 } },
      severity: 1 as const,
      message: `err${i}`,
    }))
    const block = report("big.ts", issues)
    expect(block.split("\n")).toHaveLength(DIAGNOSTICS_MAX_PER_FILE + 3) // tag + 20 + suffix + tag
    expect(block).toContain("... and 5 more")
    expect(block.match(/ERROR \[/g)).toHaveLength(DIAGNOSTICS_MAX_PER_FILE)
  })
})

describe("filterDiagnostics (Shrijan port)", () => {
  const record = {
    "/p/a.ts": [{ range: { start: { line: 0, character: 0 } }, severity: 1 as const, message: "A" }],
    "/p/b.ts": [{ range: { start: { line: 0, character: 0 } }, severity: 1 as const, message: "B" }],
  }

  it("keeps only exactly-requested files and ignores unknown names", () => {
    expect(filterDiagnostics(record, ["/p/b.ts", "/p/missing.ts"])).toEqual({ "/p/b.ts": record["/p/b.ts"] })
    expect(filterDiagnostics(record, [])).toEqual({})
  })
})

describe("parseTscOutput", () => {
  it("parses located lines into 0-based LSP diagnostics keyed by resolved path", () => {
    const cwd = path.resolve(path.sep + "proj")
    const { diagnostics, unlocated } = parseTscOutput(
      "src/a.ts(3,7): error TS2345: Argument of type 'x' is not assignable.\n",
      cwd,
    )
    expect(unlocated).toEqual([])
    const key = path.resolve(cwd, "src", "a.ts")
    expect(diagnostics[key]).toEqual([
      {
        range: { start: { line: 2, character: 6 } },
        severity: 1,
        message: "TS2345: Argument of type 'x' is not assignable.",
        code: "TS2345",
        source: "tsc",
      },
    ])
  })

  it("maps warnings to severity 2, keeps absolute paths, groups case-folded duplicates", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "diag-parse-"))
    const abs = path.join(cwd, "B.ts").replace(/\\/g, "/") // tsc prints forward slashes
    const { diagnostics } = parseTscOutput(
      `${abs}(1,2): warning TS6133: 'a' is declared but never used.\n` + `${abs}(9,9): error TS1005: ';' expected.\n`,
      cwd,
    )
    const key = path.resolve(cwd, "B.ts")
    expect(Object.keys(diagnostics)).toEqual([key])
    expect(diagnostics[key]!.map((d) => d.severity)).toEqual([2, 1])
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it("collects file-less project-level output as unlocated lines", () => {
    const { diagnostics, unlocated } = parseTscOutput(
      "error TS6053: File 'missing.ts' not found.\nmessage TS6031: Something informational.\n",
      path.resolve(path.sep),
    )
    expect(diagnostics).toEqual({})
    expect(unlocated).toHaveLength(2)
    expect(unlocated[0]).toContain("TS6053")
  })

  it("appends indented continuation lines to the previous message and ignores noise", () => {
    const cwd = path.resolve(path.sep + "c")
    const { diagnostics } = parseTscOutput(
      "a.ts(1,1): error TS2322: Type 'a' is not assignable to type\n      'b'.\nrandom noise\n",
      cwd,
    )
    const [d] = diagnostics[path.resolve(cwd, "a.ts")]!
    expect(d.message).toBe("TS2322: Type 'a' is not assignable to type 'b'.")
  })
})

describe("pickFiles / diagnosticsPathKey", () => {
  it("matches relative filters against resolved keys and returns everything for no filter", () => {
    const cwd = path.resolve(path.sep + "ws")
    const key = path.resolve(cwd, "sub", "f.ts")
    const record = { [key]: [{ range: { start: { line: 0, character: 0 } }, severity: 1 as const, message: "x" }] }
    expect(Object.keys(pickFiles(record, ["sub/f.ts"], cwd))).toEqual([key])
    expect(pickFiles(record, [], cwd)).toBe(record)
    expect(pickFiles(record, ["other.ts"], cwd)).toEqual({})
  })

  it("normalizes separators and folds case on win32", () => {
    const cwd = path.resolve(path.sep)
    expect(diagnosticsPathKey("sub/f.ts", cwd)).toBe(diagnosticsPathKey(path.join("sub", "f.ts"), cwd))
    if (process.platform === "win32") {
      expect(diagnosticsPathKey("sub/f.ts", cwd)).toBe(diagnosticsPathKey("SUB/F.TS", cwd))
    }
  })
})

describe("isCheckableFile", () => {
  it("accepts TS/TSX/MTS/CTS/JSX and rejects plain JS and other types", () => {
    for (const f of ["a.ts", "a.tsx", "a.mts", "a.cts", "a.jsx", "A.TSX"]) {
      expect(isCheckableFile(f)).toBe(true)
    }
    for (const f of ["a.js", "a.mjs", "a.cjs", "a.py", "a.md", "a.json"]) {
      expect(isCheckableFile(f)).toBe(false)
    }
  })
})

describe("syntaxDiagnostics / syntaxNote", () => {
  it("returns [] for clean and unsupported files", async () => {
    expect(await syntaxDiagnostics("export const a: number = 1;", "/x/a.ts")).toEqual([])
    expect(await syntaxDiagnostics("def broken(:", "/x/a.py")).toEqual([])
    expect(await syntaxDiagnostics("export const a = 1;", "/x/a.js")).toEqual([])
  })

  it("reports syntax errors with 0-based positions", async () => {
    const found = await syntaxDiagnostics("export const a: number = ;", "/x/a.ts")
    expect(found.length).toBeGreaterThan(0)
    expect(found[0]!.severity).toBe(1)
    expect(found[0]!.range.start.line).toBeGreaterThanOrEqual(0)
  })

  it("parses JSX in .tsx files but not in .ts files", async () => {
    expect(await syntaxDiagnostics("export const el = <div />;", "/x/a.tsx")).toEqual([])
    const broken = await syntaxDiagnostics("export const el = <div>;", "/x/a.tsx")
    expect(broken.length).toBeGreaterThan(0)
  })

  it("builds a <diagnostics> note for broken files and '' otherwise", async () => {
    const note = await syntaxNote("/x/a.ts", "export const a: number = ;")
    expect(note.startsWith("\n<diagnostics file=")).toBe(true)
    expect(await syntaxNote("/x/a.ts", "export const a: number = 1;")).toBe("")
    expect(await syntaxNote("/x/a.py", "def broken(:")).toBe("")
    expect(await syntaxNote("/x/huge.ts", `const s = "${"x".repeat(1_000_001)}";`)).toBe("")
  })
})

describe("findUp / resolveTscBin", () => {
  it("walks up to the nearest ancestor containing the file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "diag-up-"))
    const nested = path.join(root, "a", "b")
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(root, "marker.txt"), "", "utf8")
    expect(findUp("marker.txt", nested)).toBe(path.join(root, "marker.txt"))
    expect(findUp("definitely-missing-nemo-test-file.json", nested)).toBeUndefined()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("resolves the repo's typescript binary when run from the repo root", () => {
    const bin = resolveTscBin(process.cwd())
    expect(bin).toBeTruthy()
    expect(bin!.replace(/\\/g, "/")).toContain("node_modules/typescript/bin/tsc")
  })
})

/**
 * Regression (#112): `resolveTscBin` prefers the PROJECT's own
 * `node_modules/typescript/bin/tsc`, and `runTsc` spawned it with the
 * full inherited env — a planted (or supply-chain-compromised) tsc read
 * every API key in the process the moment the model called `diagnostics`.
 * The planted bin here writes the canary env var to disk; the assertion
 * is that it sees nothing.
 */
describe("tsc child env (planted-binary hygiene)", () => {
  it("runs the project's tsc with a filtered env so a planted bin never sees secrets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-env-"))
    const dump = path.join(dir, "dump.txt")
    try {
      fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}", "utf8")
      const bin = path.join(dir, "node_modules", "typescript", "bin", "tsc")
      fs.mkdirSync(path.dirname(bin), { recursive: true })
      fs.writeFileSync(
        bin,
        [
          'const fs = require("fs")',
          `fs.writeFileSync(${JSON.stringify(dump)}, "secret=" + String(process.env.R18_DIAG_SECRET))`,
          "",
        ].join("\n"),
        "utf8",
      )
      process.env.R18_DIAG_SECRET = "canary-xyz-112"
      resetDiagnosticsCache()
      const result = await collectDiagnostics(dir, true)
      expect(result.ok).toBe(true)
      const seen = fs.readFileSync(dump, "utf8")
      expect(seen).not.toContain("canary-xyz-112")
    } finally {
      resetDiagnosticsCache()
      delete process.env.R18_DIAG_SECRET
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  })
})

describe("collectDiagnostics + diagnostics tool (real tsc)", () => {
  const dirs: string[] = []

  function makeProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "diag-test-"))
    dirs.push(dir)
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ["*.ts"],
      }),
      "utf8",
    )
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content, "utf8")
    }
    return dir
  }

  beforeEach(() => {
    resetDiagnosticsCache()
  })

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  it("reports type errors for a broken project", async () => {
    const dir = makeProject({ "broken.ts": 'export const x: number = "nope";\n' })
    const result = await collectDiagnostics(dir, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const key = path.resolve(dir, "broken.ts")
    const items = result.snapshot.diagnostics[key]
    expect(items?.length).toBeGreaterThan(0)
    expect(items![0]!.code).toBe("TS2322")
    expect(items![0]!.severity).toBe(1)
    expect(result.snapshot.projectRoot).toBe(dir)
  })

  it("returns a clean snapshot for a valid project and reuses the cache", async () => {
    const dir = makeProject({ "ok.ts": "export const x: number = 1;\n" })
    const first = await collectDiagnostics(dir, true)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.snapshot.diagnostics).toEqual({})
    expect(first.snapshot.unlocated).toEqual([])
    const cached = await collectDiagnostics(dir, false)
    expect(cached.ok).toBe(true)
    if (!cached.ok) return
    expect(cached.snapshot.generatedAt).toBe(first.snapshot.generatedAt)
    const fresh = await collectDiagnostics(dir, true)
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect(fresh.snapshot.generatedAt).toBeGreaterThanOrEqual(first.snapshot.generatedAt)
  })

  it("explains when no tsconfig.json exists", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diag-noconfig-"))
    dirs.push(dir)
    const result = await collectDiagnostics(dir, true)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain("no tsconfig.json")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("tool output carries the <diagnostics> block, summary, and file filter", async () => {
    const dir = makeProject({ "broken.ts": 'export const x: number = "nope";\n' })
    const tool = createDiagnosticsTool()
    const ctx = { cwd: dir } as unknown as ToolContext

    const unfiltered = await tool.execute("call-1", {}, undefined, undefined, ctx)
    expect(unfiltered.isError).toBeFalsy()
    const unfilteredText = resultText(unfiltered)
    expect(unfilteredText).toContain("Diagnostics:")
    expect(unfilteredText).toContain("<diagnostics file=")
    expect(unfilteredText).toContain("TS2322")

    const filtered = await tool.execute("call-2", { files: ["broken.ts"] }, undefined, undefined, ctx)
    expect(resultText(filtered)).toContain("TS2322")

    const noMatch = await tool.execute("call-3", { files: ["other.ts"] }, undefined, undefined, ctx)
    expect(resultText(noMatch)).toContain("No diagnostics for: other.ts")
  })

  it("surfaces a friendly message when the run is aborted", async () => {
    const dir = makeProject({ "broken.ts": 'export const x: number = "nope";\n' })
    const tool = createDiagnosticsTool()
    const controller = new AbortController()
    controller.abort()
    const ctx = { cwd: dir } as unknown as ToolContext
    const result = await tool.execute("call-1", { refresh: true }, controller.signal, undefined, ctx)
    expect(resultText(result)).toContain("Diagnostics unavailable: aborted")
  })
})

describe("diagnostics tool timing contract", () => {
  it("kills tsc before the harness rejects the tool", () => {
    // The loop's withTimeout rejects the tool's promise at its declared
    // timeoutMs WITHOUT aborting the signal, so the internal tsc timer is the
    // only thing that kills the child. When it exceeded the tool's own budget
    // the friendly "tsc timed out" path could never fire — the harness killed
    // the tool first, leaving the child running ~15s extra, orphaned.
    const tool = createDiagnosticsTool()
    expect(TSC_TIMEOUT_MS).toBeLessThan(tool.definition.timeoutMs ?? 0)
  })
})
