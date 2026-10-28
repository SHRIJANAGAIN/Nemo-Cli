/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export function useHandlePlanClick(): {
  handlePlanClick: (planName: string) => void
} {
  const handlePlanClick = (planName: string): void => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("nemo:plan", { detail: { planName } }))
    }
  }

  return { handlePlanClick }
}
