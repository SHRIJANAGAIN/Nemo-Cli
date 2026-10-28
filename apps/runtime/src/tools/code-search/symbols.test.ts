/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSymbolSearchTool, extractSymbols, languageOf, searchSymbols } from "./symbols.js"

describe("languageOf", () => {
  it("maps extensions and rejects the rest", () => {
    expect(languageOf("a.ts")).toBe("ts")
    expect(languageOf("a.TSX")).toBe("ts")
    expect(languageOf("a.py")).toBe("py")
    expect(languageOf("a.go")).toBe("go")
    expect(languageOf("a.rs")).toBe("rust")
    expect(languageOf("a.java")).toBe("java")
    expect(languageOf("a.cpp")).toBe("c")
    expect(languageOf("README.md")).toBeNull()
    expect(languageOf("notes.txt")).toBeNull()
  })
})

describe("extractSymbols", () => {
  it("finds TypeScript definitions with line numbers", () => {
    const symbols = extractSymbols(
      [
        "export function startServer() {",
        "export class Runner {",
        "  async boot() {",
        "  }",
        "}",
        "const cb = () => 1;",
      ].join("\n"),
      "ts",
    )

    expect(symbols.map((s) => `${s.line}:${s.kind}:${s.name}`)).toEqual([
      "1:function:startServer",
      "2:class:Runner",
      "3:method:boot",
      "6:function:cb",
    ])
  })

  it("finds Python defs and classes", () => {
    const symbols = extractSymbols("class Agent:\n    async def run(self):\n        pass\n", "py")

    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(["class:Agent", "function:run"])
  })

  it("finds Go funcs, Rust fns, Java classes, C functions", () => {
    expect(extractSymbols("func Serve(port int) {", "go").map((s) => s.name)).toEqual(["Serve"])
    expect(extractSymbols("pub fn serve() {", "rust").map((s) => s.name)).toEqual(["serve"])
    expect(extractSymbols("public class Server {", "java").map((s) => `${s.kind}:${s.name}`)).toEqual(["class:Server"])
    expect(extractSymbols("int serve(int port)\n{", "c").map((s) => `${s.kind}:${s.name}`)).toEqual(["function:serve"])
  })

  it("skips keywords and call-like lines", () => {
    const symbols = extractSymbols(["if (x) {", "for (;;) {", "  return foo(bar);", "}"].join("\n"), "ts")

    expect(symbols).toEqual([])
  })

  it("survives minified single-line monsters without hanging", () => {
    const monster = `export function found() {${"x();".repeat(3000)}}`
    const started = Date.now()
    const symbols = extractSymbols(monster, "ts")

    expect(Date.now() - started).toBeLessThan(5000)
    expect(symbols.map((s) => s.name)).toContain("found")
  })
})

describe("searchSymbols", () => {
  let root = ""
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = ""
  })

  function fixture(): string {
    root = mkdtempSync(join(tmpdir(), "nemo-symbols-"))
    writeFileSync(join(root, "a.ts"), "export function startServer() {}\nstartServer();\n")
    writeFileSync(join(root, "b.py"), "def startServer():\n    pass\n")
    writeFileSync(join(root, "notes.md"), "startServer mentioned here\n")
    return root
  }

  it("finds definitions across languages, ignoring mentions", () => {
    const hits = searchSymbols(fixture(), "startServer")

    expect(hits.map((h) => `${h.file}:${h.line}:${h.kind}`)).toEqual(["a.ts:1:function", "b.py:1:function"])
  })

  it("respects glob filters and result caps", () => {
    const dir = fixture()

    expect(searchSymbols(dir, "startServer", { glob: "*.py" }).map((h) => h.file)).toEqual(["b.py"])
    expect(searchSymbols(dir, "startServer", { maxResults: 1 })).toHaveLength(1)
  })

  it("returns nothing for unknown names", () => {
    expect(searchSymbols(fixture(), "nope_nothing")).toEqual([])
  })
})

describe("createSymbolSearchTool", () => {
  it("exposes the symbol_search identity", () => {
    expect(createSymbolSearchTool().definition.name).toBe("symbol_search")
  })

  it("rejects a missing name", async () => {
    const tool = createSymbolSearchTool()
    const result = await tool.execute("t1", {}, undefined, undefined, { cwd: tmpdir() } as never)

    expect(result.isError).toBe(true)
  })

  it("reports definitions and empty results honestly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nemo-symbols-"))
    try {
      writeFileSync(join(dir, "s.ts"), "export class Engine {}\n")
      const tool = createSymbolSearchTool()

      const found = await tool.execute("t1", { name: "Engine" }, undefined, undefined, { cwd: dir } as never)
      expect(found.isError).toBe(false)
      expect(found.content.map((c) => c.text).join()).toContain("s.ts:1 [class]")

      const missing = await tool.execute("t1", { name: "Ghost" }, undefined, undefined, { cwd: dir } as never)
      expect(missing.isError).toBe(false)
      expect(missing.content.map((c) => c.text).join()).toContain("No definitions")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
