/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it, vi } from "vitest"
import { SearchNode, SotaReasoningEngine, type ScoredCandidate, type VerificationResult } from "./sota.js"
import type { WireMessage } from "../../../../packages/provider/src/types.js"

function deadCandidate(id: string, score: number): ScoredCandidate {
  return {
    id,
    text: id,
    score,
    verification: { correctness: "FAIL", evidence: [], consistency: 1, progress: 1, confidence: 1 },
    dead: true,
    needsRecheck: false,
    depth: 0,
  }
}

function aliveCandidate(id: string, score: number): ScoredCandidate {
  return {
    id,
    text: id,
    score,
    verification: { correctness: "UNCERTAIN", evidence: [], consistency: 0, progress: 0, confidence: 0 },
    dead: false,
    needsRecheck: true,
    depth: 0,
  }
}

describe("SOTA search termination", () => {
  it("bestCandidate() prefers an alive candidate over a higher-scored dead one", () => {
    const node = new SearchNode("root", "p", null, 0)
    node.candidates = [deadCandidate("bad", 0.5), aliveCandidate("ok", 0.25)]
    // The search loop expands bestNode.bestCandidate() and `continue`s on a
    // dead pick WITHOUT advancing, so returning the dead 0.5 here spins
    // forever (no await, no depth increment, abort can't even fire).
    expect(node.bestCandidate()?.dead).toBe(false) // RED: returns the dead 0.5
  })

  it("solve returns instead of spinning when the top-scored candidate is dead", async () => {
    const generate = vi.fn(
      async (_system: string, _messages: WireMessage[], options?: { temperature?: number; maxTokens?: number }) =>
        options?.temperature === 0.3 ? "bad 1" : "ok 2",
    )
    const verify = vi.fn(async (_problem: string, solution: string): Promise<VerificationResult> =>
      solution.startsWith("bad")
        ? { correctness: "FAIL", evidence: [], consistency: 1, progress: 1, confidence: 1 }
        : { correctness: "UNCERTAIN", evidence: [], consistency: 0, progress: 0, confidence: 0 },
    )
    const engine = new SotaReasoningEngine({ generate, verify })
    const result = await engine.solve("a short problem under fifty chars ok")
    expect(result).not.toBeNull() // RED: never settles (synchronous spin)
    expect(generate.mock.calls.length).toBeLessThan(20) // RED: unbounded
  })
})