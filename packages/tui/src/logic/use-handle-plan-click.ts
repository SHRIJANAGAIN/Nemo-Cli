/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export function useHandlePlanClick(): {
  handlePlanClick: (planName: string) => void
} {
  const handlePlanClick = (planName: string): void => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("trayambak:plan", { detail: { planName } }))
    }
  }

  return { handlePlanClick }
}
