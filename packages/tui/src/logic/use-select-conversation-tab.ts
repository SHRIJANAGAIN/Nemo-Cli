/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export type ConversationTab = "chat" | "planner" | "agent"

export function useSelectConversationTab(): {
  navigateToTab: (tab: ConversationTab) => void
} {
  const navigateToTab = (tab: ConversationTab): void => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("trayambak:navigate", { detail: { tab } }))
    }
  }

  return { navigateToTab }
}
