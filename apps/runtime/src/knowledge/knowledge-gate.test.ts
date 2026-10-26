/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { SearchBudget, knowledgeCheck } from "./knowledge-gate.js"

describe("knowledgeCheck", () => {
  it("treats repo-local work as known", () => {
    expect(knowledgeCheck("rename the foo helper to bar")).toEqual({
      level: "known",
      needsSearch: false,
      reason: "likely_known_or_repo_verifiable",
    })
  })

  it("flags unfamiliar or time-sensitive wording as needing search", () => {
    expect(knowledgeCheck("fix the unknown bug in the parser")).toEqual({
      level: "unfamiliar",
      needsSearch: true,
      reason: "mentions_unfamiliar_or_time_sensitive_terms",
    })
    expect(knowledgeCheck("what is the latest release of the cli")).toMatchObject({
      level: "unfamiliar",
      needsSearch: true,
    })
  })

  it("flags version questions about APIs/libraries as version_sensitive", () => {
    expect(knowledgeCheck("what version of the sdk does this project use")).toEqual({
      level: "version_sensitive",
      needsSearch: true,
      reason: "version_sensitive_api",
    })
    expect(knowledgeCheck("is this the stable package API")).toMatchObject({
      level: "version_sensitive",
      needsSearch: true,
    })
  })

  it("requires word boundaries: 'newton' is not 'new'", () => {
    expect(knowledgeCheck("implement Newton's method for the solver").level).toBe("known")
  })

  it("a version word alone (no API/library term) stays known", () => {
    expect(knowledgeCheck("check the stable branch naming").level).toBe("known")
  })
})

describe("SearchBudget", () => {
  it("starts at zero usage with a 10000 default limit", () => {
    const budget = new SearchBudget()
    expect(budget.limit).toBe(10000)
    expect(budget.usage).toBe(0)
    expect(budget.remaining).toBe(10000)
    expect(budget.tier).toBe("NORMAL")
  })

  it("spend() commits only within the limit and reports the boundary exactly", () => {
    const budget = new SearchBudget(4)
    expect(budget.canSpend(4)).toBe(true)
    expect(budget.spend(4)).toBe(true)
    expect(budget.usage).toBe(4)
    expect(budget.remaining).toBe(0)
    expect(budget.tier).toBe("BLOCKED")
    expect(budget.canSpend(1)).toBe(false)
    // A rejected spend must not consume budget.
    expect(budget.spend(1)).toBe(false)
    expect(budget.usage).toBe(4)
    expect(budget.remaining).toBe(0)
  })

  it("walks the tier ladder at the documented thresholds", () => {
    const budget = new SearchBudget(100)
    expect(budget.tier).toBe("NORMAL")
    budget.spend(69)
    expect(budget.tier).toBe("NORMAL")
    budget.spend(1) // 70%
    expect(budget.tier).toBe("CAUTION")
    budget.spend(15) // 85%
    expect(budget.tier).toBe("CONSERVE")
    budget.spend(10) // 95%
    expect(budget.tier).toBe("STRICT")
    budget.spend(5) // 100%
    expect(budget.tier).toBe("BLOCKED")
    expect(budget.usage).toBe(100)
  })
})
