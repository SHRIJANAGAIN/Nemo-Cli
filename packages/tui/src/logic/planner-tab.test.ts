/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import * as planner from "./planner-tab.js"
import { useHandlePlanClick } from "./use-handle-plan-click.js"
import { useSelectConversationTab } from "./use-select-conversation-tab.js"
import { I18nKey } from "./i18n-declaration.js"

/**
 * planner-tab is a re-export shim for the planner view: the hooks must be
 * the same function objects as their modules (not wrappers), and both type
 * exports must stay wired. The enum type check below is compile-time only —
 * it fails `npm run typecheck:logic` if the re-export disappears.
 */
describe("planner-tab barrel", () => {
  it("re-exports the click/navigate hooks by identity", () => {
    expect(planner.useHandlePlanClick).toBe(useHandlePlanClick)
    expect(planner.useSelectConversationTab).toBe(useSelectConversationTab)
  })

  it("keeps both type exports usable", () => {
    const tab: planner.ConversationTab = "planner"
    const key: planner.I18nKey = I18nKey.COMMON$PLANNER
    expect(tab).toBe("planner")
    expect(key).toBe(I18nKey.COMMON$PLANNER)
  })

  it("exposes the same working dispatchers as the hook modules", () => {
    const events: string[] = []
    ;(globalThis as Record<string, unknown>).window = {
      dispatchEvent: (event: CustomEvent<string>) => {
        events.push(event.type)
        return true
      },
    }
    try {
      planner.useHandlePlanClick().handlePlanClick("plan.md")
      planner.useSelectConversationTab().navigateToTab("chat")
      expect(events).toEqual(["trayambak:plan", "trayambak:navigate"])
    } finally {
      delete (globalThis as Record<string, unknown>).window
    }
  })
})
