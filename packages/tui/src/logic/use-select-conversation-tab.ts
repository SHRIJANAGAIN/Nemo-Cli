/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export type ConversationTab = "chat" | "planner" | "agent"

export function useSelectConversationTab(): {
  navigateToTab: (tab: ConversationTab) => void
} {
  const navigateToTab = (tab: ConversationTab): void => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("nemo:navigate", { detail: { tab } }))
    }
  }

  return { navigateToTab }
}
