/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { approvalFor, DenialTracker } from "./approval.js"

describe("approvalFor", () => {
  it("allows read-only tools without asking", () => {
    const outcome = approvalFor("read_file", { path: "a.ts" }, { uiMode: "ask" })
    expect(outcome.decision).toBe("allow")
  })

  it("asks for mutating tools in ask mode", () => {
    expect(approvalFor("write_file", { path: "a.ts" }, { uiMode: "ask" }).decision).toBe("ask")
  })

  it("denies default-dangerous commands and records them", () => {
    const tracker = new DenialTracker()
    const outcome = approvalFor("bash", { command: "rm -rf /" }, { uiMode: "ask", tracker })
    expect(outcome.decision).toBe("deny")
    expect(tracker.count("bash")).toBe(1)
    expect(tracker.total()).toBe(1)
    tracker.reset("bash")
    expect(tracker.count("bash")).toBe(0)
  })

  it("danger mode converts ask to allow but never overrides deny", () => {
    expect(approvalFor("write_file", { path: "a.ts" }, { uiMode: "ask", danger: true }).decision).toBe("allow")
    expect(approvalFor("bash", { command: "rm -rf /" }, { uiMode: "ask", danger: true }).decision).toBe("deny")
  })

  it("full-access allows everything", () => {
    expect(approvalFor("bash", { command: "rm -rf /" }, { uiMode: "full-access" }).decision).toBe("allow")
  })

  it("auto-approve gates only deletes", () => {
    expect(approvalFor("bash", { command: "rm -rf /tmp/x" }, { uiMode: "auto-approve" }).decision).toBe("ask")
    expect(approvalFor("bash", { command: "sudo whoami" }, { uiMode: "auto-approve" }).decision).toBe("allow")
  })
})
