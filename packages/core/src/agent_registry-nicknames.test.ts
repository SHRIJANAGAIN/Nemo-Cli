/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { getAgentRegistry, resetAgentRegistry } from "./agent_registry.js"

describe("AgentRegistry nickname lifecycle", () => {
  beforeEach(() => resetAgentRegistry())

  it("killAll() frees nicknames exactly like removeAgent() does", () => {
    const reg = getAgentRegistry()
    const first = reg.registerAgent("t1", {})
    expect(reg.getAgent(first.agentId)?.metadata.agentNickname).toBe("Agent")
    reg.killAll()
    // removeAgent (single) releases the nickname; killAll (all) forgot to, so
    // every reset in one process silently burned a nickname and the next
    // agent came back as "Agent the 2nd".
    const second = reg.registerAgent("t2", {})
    expect(reg.getAgent(second.agentId)?.metadata.agentNickname).toBe("Agent") // RED: "Agent the 2nd"
    expect(reg.getTotalCount()).toBe(1)
  })
})