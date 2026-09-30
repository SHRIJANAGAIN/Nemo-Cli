/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { buildSystemPrompt } from "./power-prompt.js"

declare const __dirname: string

function ctx() {
  return {
    cwd: process.cwd(),
    tools: [],
    nativeTools: true,
    model: "test-model",
  }
}

describe("buildSystemPrompt senior upgrade", () => {
  it("carries the senior protocol and evidence-first conduct", () => {
    const prompt = buildSystemPrompt(ctx())
    expect(prompt).toContain("## Senior Protocol")
    expect(prompt).toContain("Verify by execution")
    expect(prompt).toContain("Evidence before claims")
    expect(prompt).toContain("# Bug Destruction Principles")
  })

  it("inlines the whole corpus verbatim — no cap, no omission gap, no drift", () => {
    const prompt = buildSystemPrompt(ctx())
    // corpus.txt stays the editable master; after editing it, run
    // `node apps/runtime/src/prompt/embed-corpus.mjs`. A missed re-run makes
    // this assertion fail instead of shipping a stale system prompt.
    const corpus = fs.readFileSync(path.join(__dirname, "corpus.txt"), "utf8")
    // Lean-prompt floor (lowered from 80k when the stale 27k tool-docs blob,
    // the Hindi life-coach OWNERSHIP, and the phantom computer-use block were
    // cut): guards against accidental section loss, not for bulk.
    expect(corpus.length).toBeGreaterThan(45_000)
    expect(prompt).toContain(corpus)
    expect(prompt).not.toContain("middle of Trayambak operating corpus omitted")
    // Trimmed corpus + power-prompt sections: prompt ships whole but bounded.
    expect(prompt.length).toBeGreaterThan(corpus.length + 10_000)
    expect(prompt.length).toBeLessThan(corpus.length + 60_000)
  })
})
