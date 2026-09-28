/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { PointsSystem } from "./points.js"

describe("PointsSystem", () => {
  it("awards base points per difficulty with no streak bonus", () => {
    // Fresh systems so no streak bonus applies.
    expect(new PointsSystem().award("t1", "a", "d", "easy", "done").points).toBe(5)
    expect(new PointsSystem().award("t2", "b", "d", "normal", "done").points).toBe(10)
    expect(new PointsSystem().award("t3", "c", "d", "medium", "done").points).toBe(20)
    expect(new PointsSystem().award("t4", "e", "d", "high", "done").points).toBe(50)
    expect(new PointsSystem().award("t5", "f", "d", "critical", "done").points).toBe(100)
    const p = new PointsSystem()
    p.award("t6", "g", "d", "normal", "done")
    expect(p.getTotalPoints()).toBe(10)
    expect(p.getState().entries.length).toBe(1)
  })

  it("adds 10% streak bonus per consecutive award, capped at 50%", () => {
    const p = new PointsSystem()
    const awarded = Array.from({ length: 8 }, (_, i) => p.award(`t${i}`, "task", "d", "normal", "done").points)
    expect(awarded).toEqual([10, 11, 12, 13, 14, 15, 15, 15])
    expect(p.getStreak()).toBe(8)
    expect(p.getState().bestStreak).toBe(8)
  })

  it("truncates oversized assistant output to 500 chars", () => {
    const p = new PointsSystem()
    const entry = p.award("t1", "task", "d", "easy", "done", "great", "x".repeat(600))
    expect(entry.assistantOutput?.length).toBe(500)
    expect(entry.userFeedback).toBe("great")
  })

  it("deducts base penalties with a repeat-offender multiplier capped at 3x", () => {
    const p = new PointsSystem()
    const first = p.penalize("t1", "task", "d", "critical", "broke it", "error")
    expect(first.pointsDeducted).toBe(50)
    const second = p.penalize("t2", "task", "d", "critical", "broke it again", "error")
    expect(second.pointsDeducted).toBe(100)
    const third = p.penalize("t3", "task", "d", "critical", "broke it worse", "error")
    expect(third.pointsDeducted).toBe(150)
    const fourth = p.penalize("t4", "task", "d", "critical", "broke it again", "error")
    expect(fourth.pointsDeducted).toBe(150) // multiplier capped at 3
    expect(p.getTotalPoints()).toBe(-450)
  })

  it("does not multiply penalties from other categories", () => {
    const p = new PointsSystem()
    expect(p.penalize("t1", "task", "d", "critical", "loop", "error").pointsDeducted).toBe(50)
    expect(p.penalize("t2", "task", "d", "critical", "looped", "repetition").pointsDeducted).toBe(50)
  })

  it("resets the streak when a penalty is applied", () => {
    const p = new PointsSystem()
    p.award("t1", "a", "d", "normal", "done")
    p.award("t2", "a", "d", "normal", "done")
    expect(p.getStreak()).toBe(2)
    p.penalize("t3", "a", "d", "normal", "mistake", "mistake")
    expect(p.getStreak()).toBe(0)
    expect(p.getState().bestStreak).toBe(2)
  })

  it("truncates penalty input/output fields to 500 chars", () => {
    const p = new PointsSystem()
    const entry = p.penalize("t1", "t", "d", "easy", "r", "error", "fb", "u".repeat(600), "o".repeat(600))
    expect(entry.userInput?.length).toBe(500)
    expect(entry.assistantOutput?.length).toBe(500)
    expect(entry.userFeedback).toBe("fb")
  })

  it("returns a detached copy of the state", () => {
    const p = new PointsSystem()
    p.award("t1", "a", "d", "easy", "done")
    const snapshot = p.getState()
    snapshot.totalPoints = 99_999
    expect(p.getTotalPoints()).toBe(5)
  })

  it("renders a report without penalties", () => {
    const p = new PointsSystem()
    expect(p.getReport()).toBe("Total Points: 0\nCurrent Streak: 0\nBest Streak: 0\nTasks Completed: 0\nPenalties: 0")
  })

  it("lists at most the five most recent penalties in the report", () => {
    const p = new PointsSystem()
    p.award("t0", "a", "d", "critical", "done") // 100 points
    for (let i = 0; i < 6; i++) {
      p.penalize(`t${i}`, "a", "d", "easy", `reason ${i}`, "mistake")
    }
    const report = p.getReport()
    expect(report).toContain("Recent Penalties:")
    const penaltyLines = report.split("\n").filter((l) => l.startsWith("  -"))
    expect(penaltyLines.length).toBe(5)
    // Same-category penalties inside the hour escalate 2 → 4 → 6 (capped 3x);
    // the report keeps only the last five (reasons 1-5).
    expect(penaltyLines[0]).toBe("  -4 [mistake] reason 1")
    expect(penaltyLines[4]).toBe("  -6 [mistake] reason 5")
    expect(report).toContain("Penalties: 6")
    expect(report).toContain("Total Points: 70") // 100 - (2+4+6+6+6+6)
  })
})
