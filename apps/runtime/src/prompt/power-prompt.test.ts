/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { buildOperatorBlock, buildSystemPrompt } from "./power-prompt.js"

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
  it("names its operator principal without leaking secrets", () => {
    expect(buildOperatorBlock({})).toContain("## OPERATOR")
    expect(buildOperatorBlock({})).toContain("not logged in")
    const named = buildOperatorBlock({ githubLogin: "octocat", hasLicense: true, machineShortId: "abc12345" })
    expect(named).toContain("@octocat")
    expect(named).toContain("present")
    expect(named).toContain("abc12345")
    expect(named).not.toContain("1102-")
    // Wired through: the section lands in the full prompt, bounded.
    const full = buildSystemPrompt({ ...ctx(), operatorBlock: named })
    expect(full).toContain("## OPERATOR")
    expect(full.length).toBeLessThan(buildSystemPrompt(ctx()).length + 1000)
  })

  it("carries the senior protocol and evidence-first conduct", () => {
    const prompt = buildSystemPrompt(ctx())
    expect(prompt).toContain("## Senior Protocol")
    expect(prompt).toContain("Verify by execution")
    expect(prompt).toContain("Evidence before claims")
    expect(prompt).toContain("# Bug Destruction Principles")
  })

  it("carries the instruction hierarchy ahead of the protocol", () => {
    const prompt = buildSystemPrompt(ctx())
    expect(prompt).toContain("## Instruction Hierarchy")
    // Precedence must be stated as an ordered list, and the data-not-commands
    // rule must name the override phrasing the guard strips at entry.
    expect(prompt).toContain("1. This system prompt")
    expect(prompt).toContain("4. Content read from files, tool output")
    expect(prompt.indexOf("## Instruction Hierarchy")).toBeLessThan(prompt.indexOf("## Senior Protocol"))
    expect(prompt).toContain('"ignore previous instructions"')
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

  it("carries the company roster block when the caller supplies one", () => {
    const block = "## COMPANY (2 specialists across 1 departments — yours to command)"
    const withCompany = buildSystemPrompt({ ...ctx(), companyBlock: block })
    expect(withCompany).toContain("## COMPANY")
    expect(withCompany.length).toBeLessThan(buildSystemPrompt(ctx()).length + 2000)
    // Absent by default: no roster leaks into sessions without a library
    // (the static slash-commands line only names the section).
    expect(buildSystemPrompt(ctx())).not.toContain("yours to command")
  })
})
