/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { EvidenceStore } from "./evidence-store.js"

describe("EvidenceStore", () => {
  it("add() creates an UNVERIFIED entry with a generated id and timestamp", () => {
    const store = new EvidenceStore()
    const entry = store.add("the build passes", "ci log line 42", "ci-run-1")
    expect(entry.status).toBe("UNVERIFIED")
    expect(entry.claim).toBe("the build passes")
    expect(entry.evidence).toBe("ci log line 42")
    expect(entry.source).toBe("ci-run-1")
    expect(entry.id.startsWith("ev_")).toBe(true)
    expect(() => new Date(entry.timestamp).toISOString()).not.toThrow()
  })

  it("verify() and contradict() flip status and report whether the id exists", () => {
    const store = new EvidenceStore()
    const a = store.add("claim a", "ev a", "s")
    const b = store.add("claim b", "ev b", "s")

    expect(store.verify(a.id)).toBe(true)
    expect(store.contradict(b.id)).toBe(true)
    expect(a.status).toBe("VERIFIED")
    expect(b.status).toBe("CONTRADICTED")

    expect(store.verify("ev_missing")).toBe(false)
    expect(store.contradict("ev_missing")).toBe(false)
  })

  it("a verified entry can later be contradicted", () => {
    const store = new EvidenceStore()
    const entry = store.add("claim", "ev", "s")
    store.verify(entry.id)
    store.contradict(entry.id)
    expect(entry.status).toBe("CONTRADICTED")
    expect(store.getVerified()).toEqual([])
    expect(store.getContradicted()).toHaveLength(1)
  })

  it("partitions entries across the three getters", () => {
    const store = new EvidenceStore()
    const a = store.add("claim a", "ev a", "s")
    const b = store.add("claim b", "ev b", "s")
    const c = store.add("claim c", "ev c", "s")
    store.verify(a.id)
    store.contradict(b.id)

    expect(store.getVerified().map((e) => e.id)).toEqual([a.id])
    expect(store.getUnverified().map((e) => e.id)).toEqual([c.id])
    expect(store.getContradicted().map((e) => e.id)).toEqual([b.id])
    expect(a.status).toBe("VERIFIED")
    expect(c.status).toBe("UNVERIFIED")
  })

  it("summary() counts each bucket", () => {
    const store = new EvidenceStore()
    expect(store.summary()).toBe("Evidence: 0 verified, 0 unverified, 0 contradicted")
    const a = store.add("claim a", "ev a", "s")
    const b = store.add("claim b", "ev b", "s")
    store.add("claim c", "ev c", "s")
    store.verify(a.id)
    store.contradict(b.id)
    expect(store.summary()).toBe("Evidence: 1 verified, 1 unverified, 1 contradicted")
  })
})
