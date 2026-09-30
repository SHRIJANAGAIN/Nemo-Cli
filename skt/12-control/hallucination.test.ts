/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { HallucinationDetector } from "./hallucination.js"

describe("HallucinationDetector.analyze", () => {
  it("classifies uncertainty phrases as assumptions, not hallucinations", () => {
    const r = new HallucinationDetector().analyze("I think this approach will work")
    expect(r.isHallucination).toBe(false)
    expect(r.type).toBe("ASSUMPTION")
    expect(r.detail).toBe('Uncertainty phrase detected: "i think"')
    expect(r.confidence).toBe(0.5)
    expect(r.requiresEvidence).toBe(true)
  })

  it("flags an evidence-free claim as a hallucination", () => {
    const r = new HallucinationDetector().analyze("I fixed the bug")
    expect(r.isHallucination).toBe(true)
    expect(r.type).toBe("UNKNOWN")
    expect(r.detail).toBe('Claim without evidence: "i fixed"')
    expect(r.confidence).toBe(0.3)
    expect(r.requiresEvidence).toBe(true)
  })

  it("accepts a claim that is backed by evidence", () => {
    const r = new HallucinationDetector().analyze("I fixed the bug, exit code 0")
    expect(r.isHallucination).toBe(false)
    expect(r.type).toBe("FACT")
    expect(r.detail).toBe('Claim with evidence: "i fixed"')
    expect(r.confidence).toBe(0.8)
    expect(r.requiresEvidence).toBe(false)
  })

  it("detects factual statements", () => {
    const r = new HallucinationDetector().analyze("The build is passing")
    expect(r.isHallucination).toBe(false)
    expect(r.type).toBe("FACT")
    expect(r.detail).toBe("Factual statement detected")
    expect(r.confidence).toBe(0.9)
  })

  it("matches the other factual patterns", () => {
    const d = new HallucinationDetector()
    expect(d.analyze("This is fine").type).toBe("FACT")
    expect(d.analyze("the archive contains 3 files").type).toBe("FACT")
    expect(d.analyze("version 1.2.3 shipped today").type).toBe("FACT")
  })

  it("treats neutral text as an observation", () => {
    const d = new HallucinationDetector()
    const r = d.analyze("hello there")
    expect(r.type).toBe("OBSERVATION")
    expect(r.confidence).toBe(0.7)
    expect(r.requiresEvidence).toBe(false)
    // claims are never collected by the current implementation
    expect(d.getClaims()).toEqual([])
  })

  it("honors custom uncertainty and claim phrases", () => {
    const d = new HallucinationDetector({
      uncertaintyPhrases: ["not sure"],
      claimPhrases: ["all done"],
    })
    expect(d.analyze("not sure about the result").type).toBe("ASSUMPTION")
    const claim = d.analyze("all done with the migration")
    expect(claim.isHallucination).toBe(true)
    expect(claim.detail).toBe('Claim without evidence: "all done"')
  })
})

describe("HallucinationDetector.classify", () => {
  it("maps each phrase/evidence class to its evidence type", () => {
    const d = new HallucinationDetector()
    expect(d.classify("maybe it works")).toBe("ASSUMPTION")
    expect(d.classify("I have updated the config")).toBe("INFERENCE")
    expect(d.classify("tests passed with coverage")).toBe("FACT")
    expect(d.classify("The build is passing")).toBe("OBSERVATION")
    expect(d.classify("just chatting")).toBe("UNKNOWN")
  })

  it("clears accumulated text on reset without error", () => {
    const d = new HallucinationDetector()
    d.analyze("some text")
    d.reset()
    expect(d.getClaims()).toEqual([])
    expect(d.analyze("hello").type).toBe("OBSERVATION")
  })
})
