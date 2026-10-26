/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import type { ToolContext, ToolResult } from "../types.js"
import { createReadManifestTool } from "./read-manifest.js"

const dirs: string[] = []

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-manifest-cargo-"))
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

async function run(cwd: string): Promise<string> {
  const tool = createReadManifestTool()
  const res = await tool.execute("t1", {}, undefined, undefined, { cwd } as unknown as ToolContext)
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

describe("read_manifest Cargo dependencies", () => {
  it("reports dependency KEYs, not whole `key = value` lines", async () => {
    // `l.split(/\s*=\s*/, 1)` never splits (limit 1 = whole line), so every
    // line fell to the quote-strip branch and `serde = "1"` was echoed with
    // its dangling quote — contradicting the go.mod/npm/pyproject siblings
    // which list bare module names.
    const text = await run(
      project({
        "Cargo.toml":
          '[package]\nname = "mycrate"\nversion = "0.4.1"\n\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n',
      }),
    )
    expect(text).toContain("dependencies (2): serde, tokio") // RED: 'dependencies (2): serde = "1, tokio = { version = "1" }'
  })
})