/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { buildInitPrompt, buildReviewPrompt, parseReviewArgs } from "./review-init.js"

describe("parseReviewArgs", () => {
  it("defaults bare input to the working tree", () => {
    expect(parseReviewArgs("")).toEqual({ kind: "working-tree" })
    expect(parseReviewArgs("   ")).toEqual({ kind: "working-tree" })
    expect(parseReviewArgs("nonsense").kind).toBe("working-tree")
  })

  it("parses commit and branch targets, capping ref length", () => {
    expect(parseReviewArgs("commit abc123")).toEqual({ kind: "commit", ref: "abc123" })
    expect(parseReviewArgs("branch main")).toEqual({ kind: "branch", ref: "main" })
    expect(parseReviewArgs("COMMIT deadbee")).toEqual({ kind: "commit", ref: "deadbee" })
    const long = parseReviewArgs(`branch ${"x".repeat(100)}`)
    expect((long as { ref: string }).ref.length).toBe(64)
  })

  it("requires a ref after the keyword", () => {
    expect(parseReviewArgs("commit").kind).toBe("working-tree")
    expect(parseReviewArgs("branch").kind).toBe("working-tree")
  })
})

describe("buildReviewPrompt", () => {
  it("targets the working tree by default with staged+unstaged diff", () => {
    const p = buildReviewPrompt("")
    expect(p).toContain("uncommitted working-tree changes")
    expect(p).toContain("git diff --cached")
    expect(p).toContain("trayambak__ParallelReview")
    expect(p).toContain("Adversarially verify")
    expect(p).toContain("performance")
    expect(p).toContain("test coverage")
  })

  it("uses git show for commits and triple-dot diff for branches", () => {
    expect(buildReviewPrompt("commit abc123")).toContain("git show abc123")
    expect(buildReviewPrompt("branch main")).toContain("git diff main...HEAD")
  })
})

describe("buildInitPrompt", () => {
  it("covers scan, AGENTS.md write, memory store, and scope guard", () => {
    const p = buildInitPrompt()
    expect(p).toContain("AGENTS.md")
    expect(p).toContain("README")
    expect(p).toContain("memory tool")
    expect(p).toContain("Do not start unrelated work")
  })
})
