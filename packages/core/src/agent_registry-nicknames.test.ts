/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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