/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * read_manifest — real filesystem via mkdtemp fixtures (no network involved).
 *
 * Pins the bug fixes:
 *  - PEP 621 pyproject keeps `dependencies` as an array KEY inside [project];
 *    the old sectionLines("project.dependencies") sought a [project.dependencies]
 *    HEADER that never exists, so deps/build-requires were never summarized
 *  - tsconfig.json is JSONC (comments + trailing commas); plain JSON.parse
 *    reported nearly every real config as "unparseable"
 *  - name/version prefer the [project] table (tool.poetry files fall back to
 *    a whole-file scan)
 *  - BOM-prefixed package.json parses
 * Plus: depth/nesting, first-manifest-only, node_modules/dot-dir skipping.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import type { ToolContext, ToolResult } from "../types.js"
import { createReadManifestTool } from "./read-manifest.js"

const dirs: string[] = []

/** Materialize a fixture project in a fresh temp dir; cleaned afterEach. */
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-manifest-"))
  dirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
  return dir
}

function firstText(result: ToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : ""
}

async function run(cwd: string, args: Record<string, unknown> = {}): Promise<string> {
  const tool = createReadManifestTool()
  const res = await tool.execute("t1", args, undefined, undefined, { cwd } as unknown as ToolContext)
  return firstText(res)
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
})

describe("package.json", () => {
  it("summarizes name, version, scripts, and dependency groups", async () => {
    const dir = project({
      "package.json": JSON.stringify({
        name: "demo",
        version: "1.2.3",
        type: "module",
        scripts: { test: "vitest", build: "tsc" },
        dependencies: { a: "1", b: "2" },
        devDependencies: { c: "3" },
      }),
    })
    const text = await run(dir)
    expect(text).toContain("Manifest: package.json")
    expect(text).toContain("name: demo")
    expect(text).toContain("version: 1.2.3")
    expect(text).toContain("type: module")
    expect(text).toContain("scripts: test, build")
    expect(text).toContain("dependencies (2): a, b")
    expect(text).toContain("devDependencies (1): c")
  })

  it("survives a BOM prefix (real editors emit one)", async () => {
    const dir = project({ "package.json": "\uFEFF" + JSON.stringify({ name: "bompkg", version: "9.9.9" }) })
    const text = await run(dir)
    expect(text).toContain("name: bompkg")
    expect(text).toContain("version: 9.9.9")
  })

  it("falls back to a generic head dump when unparseable", async () => {
    const dir = project({ "package.json": "{ not json at all" })
    const text = await run(dir)
    expect(text).toContain("package.json (unparseable):")
    expect(text).toContain("{ not json at all")
  })
})

describe("pyproject.toml (PEP 621)", () => {
  it("reads dependencies and build requires from their array keys", async () => {
    const dir = project({
      "pyproject.toml": [
        "[project]",
        'name = "mypkg"',
        'version = "2.0"',
        "dependencies = [",
        '  "requests>=2",',
        '  "click>=8",',
        "]",
        "",
        "[build-system]",
        'requires = ["setuptools>=61", "wheel"]',
        'build-backend = "setuptools.build_meta"',
        "",
      ].join("\n"),
    })
    const text = await run(dir)
    expect(text).toContain("Manifest: pyproject.toml")
    expect(text).toContain("name: mypkg")
    expect(text).toContain("version: 2.0")
    // Before the fix both lines were silently absent: sectionLines() looked
    // for [project.dependencies]/[build-system.requires] HEADER rows.
    expect(text).toContain("dependencies (2): requests>=2, click>=8")
    expect(text).toContain("build requires (2): setuptools>=61, wheel")
  })

  it("prefers [project] but falls back to tool.poetry-style tables", async () => {
    const mixed = project({
      "pyproject.toml": ["[tool.poetry]", 'name = "poetryname"', "", "[project]", 'name = "projectname"', ""].join(
        "\n",
      ),
    })
    const mixedText = await run(mixed)
    expect(mixedText).toContain("name: projectname")
    expect(mixedText).not.toContain("poetryname")

    const poetryOnly = project({
      "pyproject.toml": ["[tool.poetry]", 'name = "poetrypkg"', 'version = "3.0"', ""].join("\n"),
    })
    const poetryText = await run(poetryOnly)
    expect(poetryText).toContain("name: poetrypkg")
    expect(poetryText).toContain("version: 3.0")
  })
})

describe("other manifests", () => {
  it("filters requirements.txt flags and comments", async () => {
    const dir = project({
      "requirements.txt": "# comment\n\n-r other.txt\n--index-url https://x\nrequests>=2\nflask==3.0\n",
    })
    const text = await run(dir)
    expect(text).toContain("2 requirement(s): requests>=2, flask==3.0")
  })

  it("reports an empty requirements.txt honestly", async () => {
    const dir = project({ "requirements.txt": "# only a comment\n\n" })
    expect(await run(dir)).toContain("empty requirements.txt")
  })

  it("summarizes Cargo package fields and dependency tables", async () => {
    const dir = project({
      "Cargo.toml": [
        "[package]",
        'name = "mycrate"',
        'version = "0.4.1"',
        "",
        "[dependencies]",
        'serde = "1"',
        'tokio = { version = "1" }',
        "",
        "[dev-dependencies]",
        'proptest = "1"',
        "",
      ].join("\n"),
    })
    const text = await run(dir)
    expect(text).toContain("Manifest: Cargo.toml")
    expect(text).toContain("name: mycrate")
    expect(text).toContain("version: 0.4.1")
    expect(text).toContain("dependencies (2):")
    expect(text).toContain("serde")
    expect(text).toContain("dev-dependencies (1):")
    expect(text).toContain("proptest")
  })

  it("parses go.mod module, version, and the require block", async () => {
    const dir = project({
      "go.mod":
        "module github.com/acme/tool\n\ngo 1.22\n\nrequire (\n\tgithub.com/pkg/errors v0.9.1\n\tgolang.org/x/sync v0.7.0\n)\n",
    })
    const text = await run(dir)
    expect(text).toContain("module: github.com/acme/tool")
    expect(text).toContain("go: 1.22")
    expect(text).toContain("require (2): github.com/pkg/errors, golang.org/x/sync")
  })

  it("falls back to a generic head dump for pom.xml", async () => {
    const dir = project({ "pom.xml": "<project>\n  <artifactId>demo</artifactId>\n</project>\n" })
    const text = await run(dir)
    expect(text).toContain("Manifest: pom.xml")
    expect(text).toContain("Java/Maven (pom.xml):")
    expect(text).toContain("<artifactId>demo</artifactId>")
  })

  it("parses JSONC tsconfig (comments, trailing commas, slash-heavy strings)", async () => {
    const dir = project({
      "tsconfig.json": [
        "{",
        "  // Target output",
        '  "compilerOptions": {',
        '    "target": "ES2022",',
        '    "module": "NodeNext",',
        '    "strict": true,',
        '    "outDir": "dist",',
        "  },",
        "  /* Files to include */",
        '  "include": ["src/**/*"],',
        "}",
        "",
      ].join("\n"),
    })
    const text = await run(dir)
    // Before the fix this was "unparseable tsconfig.json".
    expect(text).toContain("target: ES2022")
    expect(text).toContain("module: NodeNext")
    expect(text).toContain("strict: true")
    expect(text).toContain("outDir: dist")
    expect(text).toContain("include: src/**/*")
    expect(text).not.toContain("unparseable")
  })
})

describe("traversal", () => {
  it("finds nested manifests only up to the requested depth", async () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "root" }),
      "sub/Cargo.toml": '[package]\nname = "nested"\nversion = "0.1.0"\n',
    })
    const deep = await run(dir, { depth: 1 })
    const nested = `Manifest: ${path.join("sub", "Cargo.toml")}`
    expect(deep).toContain("Manifest: package.json")
    expect(deep).toContain(nested)
    expect(deep).toContain("name: nested")

    const shallow = await run(dir, { depth: 0 })
    expect(shallow).toContain("Manifest: package.json")
    expect(shallow).not.toContain(nested)
  })

  it("skips node_modules and dot-directories", async () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "root" }),
      "node_modules/pkg/package.json": JSON.stringify({ name: "sneaky" }),
      ".hidden/Cargo.toml": '[package]\nname = "hidden"\n',
    })
    const text = await run(dir)
    expect((text.match(/Manifest:/g) ?? []).length).toBe(1)
    expect(text).not.toContain("node_modules")
    expect(text).not.toContain("hidden")
  })

  it("reports when nothing supported exists", async () => {
    const dir = project({ "README.md": "# hi" })
    const text = await run(dir)
    expect(text).toBe(`No supported manifest found under ${dir}`)
  })
})
