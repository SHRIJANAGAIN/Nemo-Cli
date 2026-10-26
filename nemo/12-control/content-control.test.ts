/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { ContentControl } from "./content-control.js"

const OK = 'node -e "process.exit(0)"'

const makeControl = (cwd = "unused"): ContentControl =>
  new ContentControl({ cwd }, "t1", "the task", "the description", "normal")

describe("ContentControl.ingest", () => {
  it("passes clean text through without cutting or retrying", () => {
    const r = makeControl().ingest("hello there")
    expect(r.shouldCut).toBe(false)
    expect(r.shouldRetry).toBe(false)
    expect(r.pointsAwarded).toBe(0)
    expect(r.pointsDeducted).toBe(0)
    expect(r.message).toBe("")
    expect(r.repetition.level).toBe(0)
    expect(r.hallucination.type).toBe("OBSERVATION")
  })

  it("cuts, retries, and penalizes on token repetition", () => {
    const cc = makeControl()
    const r = cc.ingest("spam spam spam spam spam")
    expect(r.shouldCut).toBe(true)
    expect(r.shouldRetry).toBe(true)
    expect(r.repetition.level).toBe(1)
    expect(r.message).toBe('REPETITION DETECTED (Level 1): Token "spam" repeated 5 times consecutively')
    expect(r.pointsDeducted).toBe(10) // severity high
    expect(cc.getPointsState().totalPoints).toBe(-5) // normal-difficulty base penalty
    expect(cc.getPointsState().penalties[0]?.category).toBe("repetition")
  })

  it("cuts, retries, and penalizes on an evidence-free claim", () => {
    const cc = makeControl()
    const r = cc.ingest("I fixed the bug")
    expect(r.shouldCut).toBe(true)
    expect(r.shouldRetry).toBe(true)
    expect(r.repetition.level).toBe(0)
    expect(r.hallucination.isHallucination).toBe(true)
    expect(r.message).toBe('HALLUCINATION DETECTED: Claim without evidence: "i fixed"')
    expect(r.pointsDeducted).toBe(10)
    expect(cc.getPointsState().totalPoints).toBe(-5)
    expect(cc.getPointsState().penalties[0]?.category).toBe("hallucination")
  })

  it("stacks both penalties and lets the hallucination message win", () => {
    const cc = makeControl()
    const r = cc.ingest("spam spam spam spam spam i fixed the bug")
    expect(r.repetition.level).toBe(1)
    expect(r.hallucination.isHallucination).toBe(true)
    expect(r.pointsDeducted).toBe(20)
    expect(r.message.startsWith("HALLUCINATION DETECTED:")).toBe(true)
    expect(cc.getPointsState().totalPoints).toBe(-10)
    expect(cc.getPointsState().penalties.length).toBe(2)
  })

  it("awards points and renders a points report", () => {
    const cc = makeControl()
    cc.awardPoints("finished the task", "nice work")
    const state = cc.getPointsState()
    expect(state.totalPoints).toBe(10)
    expect(state.entries.length).toBe(1)
    expect(state.entries[0]?.reason).toBe("finished the task")
    expect(state.entries[0]?.userFeedback).toBe("nice work")
    expect(cc.getPointsReport()).toContain("Total Points: 10")
  })

  it("lets the same text pass again after reset", () => {
    const cc = makeControl()
    expect(cc.ingest("spam spam spam spam spam").shouldCut).toBe(true)
    cc.reset()
    expect(cc.ingest("hello there").shouldCut).toBe(false)
  })
})

describe("ContentControl.verify", () => {
  let tmp = ""

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-content-"))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("runs the fixed typecheck/unit_test/build pipeline against the cwd", async () => {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        name: "verify-fixture",
        version: "1.0.0",
        scripts: { typecheck: OK, test: OK, build: OK },
      }),
      "utf8",
    )
    const report = await makeControl(tmp).verify()
    expect(report.steps.map((s) => s.step)).toEqual(["typecheck", "unit_test", "build"])
    expect(report.steps.every((s) => s.status === "pass")).toBe(true)
    expect(report.overall).toBe("pass")
  }, 60_000)
})
