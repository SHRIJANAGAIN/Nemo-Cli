/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Cross-tool path containment for the read-only search tools.
 *
 * `read_file`, `glob`, `list_dir`, `grep`, and `skills` all routed their `path`
 * argument through `resolveConstrainedPath`. Four others did not —
 * `code_search`, `symbols`, `semantic_search`, and `read_manifest` each did a
 * bare `path.resolve(ctx.cwd, args.path)` and read whatever came out. The gate
 * allows cwd-or-home, so "no gate" means "anywhere on the filesystem". Verified
 * before the fix: given a directory outside both, `read_manifest` returned its
 * `package.json` and `code_search` returned matching file CONTENT, while
 * `read_file` on the same path returned "Access denied".
 *
 * That matters because these tools return file content, so an injected tool
 * call (the `evil.md` class) had a read primitive the gated one refused — and
 * `read_file` denying what `code_search` happily returns is the kind of
 * inconsistency that gets exploited rather than noticed.
 *
 * The out-of-scope target is a one-file directory created at the drive root, so
 * the ungated path scans something small and the proof terminates. Creating it
 * needs no privileges here; where that is refused the suite skips rather than
 * reporting a containment failure it could not stage.
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createCodeSearchTool } from "./code-search/code-search.js"
import { createSemanticSearchTool } from "./code-search/semantic-search.js"
import { createSymbolSearchTool } from "./code-search/symbols.js"
import { createReadManifestTool } from "./manifest/read-manifest.js"
import type { Tool, ToolContext } from "./types.js"

const tempDirs: string[] = []
const outside = path.join(path.parse(process.cwd()).root, `tbtmp-containment-${process.pid}`)

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contain-"))
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "in-scope-canary" }), "utf8")
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const IN_SCOPE_TOKEN_ZZZ = 1\n", "utf8")
  tempDirs.push(dir)
  return dir
}

/** A small directory outside cwd AND home, holding a canary. */
function stageOutside(): boolean {
  try {
    fs.mkdirSync(path.join(outside, "src"), { recursive: true })
    fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "out-of-scope-canary" }), "utf8")
    fs.writeFileSync(path.join(outside, "src", "b.ts"), "export const OUT_OF_SCOPE_TOKEN_ZZZ = 1\n", "utf8")
    return true
  } catch {
    return false
  }
}

const ctxFor = (cwd: string): ToolContext => ({ config: { cwd }, cwd }) as unknown as ToolContext

async function call(tool: Tool, args: Record<string, unknown>, cwd: string): Promise<string> {
  const out = await tool.execute("1", args, undefined, undefined, ctxFor(cwd))
  const text = out.content.map((p) => ("text" in p ? String(p.text) : "")).join("")
  return `${text}\n<<isError=${String(out.isError)}>>`
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) break
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
  try {
    fs.rmSync(outside, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
})

const cases: Array<[string, () => Tool, Record<string, unknown>]> = [
  ["code_search", createCodeSearchTool, { query: "OUT_OF_SCOPE_TOKEN_ZZZ" }],
  ["symbols", createSymbolSearchTool, { name: "OUT_OF_SCOPE_TOKEN_ZZZ" }],
  ["semantic_search", createSemanticSearchTool, { query: "OUT_OF_SCOPE_TOKEN_ZZZ" }],
  ["read_manifest", createReadManifestTool, { depth: 1 }],
]

describe("read-only search tools apply the shared path gate", () => {
  it.each(cases)("%s refuses a path outside the project and the home dir", async (_name, make, args) => {
    if (!stageOutside()) return // could not stage an out-of-home target here
    const out = await call(make(), { ...args, path: outside }, workspace())
    expect(out).toContain("<<isError=true>>")
    expect(out).toContain("Access denied")
    // Nothing from outside the project leaked into the reply.
    expect(out).not.toContain("out-of-scope-canary")
    expect(out).not.toContain("OUT_OF_SCOPE_TOKEN_ZZZ")
  })

  it.each(cases)("%s still reads the project directory (no over-blocking)", async (_name, make, args) => {
    const cwd = workspace()
    // Explicit in-scope path…
    expect(await call(make(), { ...args, path: cwd }, cwd)).not.toContain("Access denied")
    // …and the implicit default (base = cwd).
    expect(await call(make(), args, cwd)).not.toContain("Access denied")
  })
})
