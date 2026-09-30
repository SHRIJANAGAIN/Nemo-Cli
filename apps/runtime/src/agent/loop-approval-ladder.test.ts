/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Approval-ladder harness tests: the agent loop's permission gate must
 * flow through approvalFor() (packages/core/src/approval.ts) — deny
 * hard-blocks and records on the run tracker, ask emits permission_request
 * (force-ask flagged), full-access executes. Deterministic, no network.
 */

import { describe, expect, it } from "vitest"
import { DenialTracker } from "../../../../packages/core/src/approval.js"
import {
  assertProviderCalls,
  eventsOfType,
  makeScriptedProvider,
  probeTool,
  runTestLoop,
  testBaseConfig,
  textReply,
  toolReply,
  toolTexts,
} from "./loop-test-harness.js"

describe("loop approval ladder (approvalFor)", () => {
  it("denies an explicitly denied tool and records it on the run tracker", async () => {
    const tracker = new DenialTracker()
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: {
        mode: "default",
        rules: [],
        askByDefault: true,
        rulesV2: [{ tool: "probe", pattern: "*", action: "deny" }],
      },
    })
    const { events, messages } = await runTestLoop("go", config, scripted, {
      tools: [probeTool("probe", executed)],
      approvalTracker: tracker,
    })
    expect(executed).toHaveLength(0)
    expect(toolTexts(messages).join("\n")).toContain("Trayambak permission denied for probe")
    expect(eventsOfType(events, "permission_request")).toHaveLength(0)
    expect(tracker.count("probe")).toBe(1)
    assertProviderCalls(scripted.calls(), 2, "deny path turns")
  })

  it("asks with forceAsk for sensitive ops and denies without an approver", async () => {
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "bash", { command: "sudo whoami" }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true },
    })
    const { events } = await runTestLoop("go", config, scripted, {
      tools: [probeTool("bash", executed)],
    })
    expect(executed).toHaveLength(0)
    const requests = eventsOfType(events, "permission_request")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.forceAsk).toBe(true)
    assertProviderCalls(scripted.calls(), 2, "ask path turns")
  })

  it("full-access executes through the ladder without prompts", async () => {
    const tracker = new DenialTracker()
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true, uiMode: "full-access" },
    })
    const { events } = await runTestLoop("go", config, scripted, {
      tools: [probeTool("probe", executed)],
      approvalTracker: tracker,
    })
    expect(executed).toEqual(['{"n":1}'])
    expect(eventsOfType(events, "permission_request")).toHaveLength(0)
    expect(tracker.total()).toBe(0)
    assertProviderCalls(scripted.calls(), 2, "allow path turns")
  })

  it("approved ask executes the tool", async () => {
    const executed: string[] = []
    const scripted = makeScriptedProvider([toolReply("c1", "probe", { n: 1 }), textReply("done")])
    const config = testBaseConfig({
      permissions: { mode: "default", rules: [], askByDefault: true },
    })
    await runTestLoop("go", config, scripted, {
      tools: [probeTool("probe", executed)],
      onRequestPermission: async () => true,
    })
    expect(executed).toEqual(['{"n":1}'])
    assertProviderCalls(scripted.calls(), 2, "approved ask turns")
  })
})
