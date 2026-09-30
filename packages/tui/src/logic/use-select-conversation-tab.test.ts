/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { useSelectConversationTab, type ConversationTab } from "./use-select-conversation-tab.js"

/**
 * Tab navigation is an event, not React state: every ConversationTab value
 * must be broadcast as `trayambak:navigate` so the host shell can switch
 * panes. The `typeof window` guard keeps SSR rendering crash-free.
 */
const dispatched: CustomEvent[] = []

const stubWindow = (): void => {
  ;(globalThis as Record<string, unknown>).window = {
    dispatchEvent: (event: CustomEvent) => {
      dispatched.push(event)
      return true
    },
  }
}

const dropWindow = (): void => {
  delete (globalThis as Record<string, unknown>).window
}

beforeEach(() => {
  dispatched.length = 0
  stubWindow()
})

afterEach(dropWindow)

describe("useSelectConversationTab", () => {
  it("broadcasts every conversation tab in the union", () => {
    const { navigateToTab } = useSelectConversationTab()
    const tabs: ConversationTab[] = ["chat", "planner", "agent"]
    for (const tab of tabs) navigateToTab(tab)

    expect(dispatched.map((event) => event.type)).toEqual([
      "trayambak:navigate",
      "trayambak:navigate",
      "trayambak:navigate",
    ])
    expect(dispatched.map((event) => event.detail.tab)).toEqual(tabs)
  })

  it("sends exactly one event per navigation", () => {
    useSelectConversationTab().navigateToTab("planner")
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.detail).toEqual({ tab: "planner" })
  })

  it("is a silent no-op without a window (non-DOM runtime)", () => {
    dropWindow()
    expect(() => useSelectConversationTab().navigateToTab("chat")).not.toThrow()
    expect(dispatched).toHaveLength(0)
  })
})
