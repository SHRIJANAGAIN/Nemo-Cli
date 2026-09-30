/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export function useHandleBuildPlanClick(): {
  handleBuildPlanClick: (event?: React.MouseEvent<HTMLButtonElement>) => void
} {
  const handleBuildPlanClick = (_event?: React.MouseEvent<HTMLButtonElement>): void => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("trayambak:build-plan"))
    }
  }

  return { handleBuildPlanClick }
}
