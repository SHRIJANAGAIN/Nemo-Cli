/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export interface ScrollFadeState {
  left: boolean
  right: boolean
}

export function readScrollFadeState(element: HTMLElement): ScrollFadeState {
  const { scrollLeft, scrollWidth, clientWidth } = element
  const hasOverflow = scrollWidth > clientWidth
  const margin = 1
  return {
    left: hasOverflow && scrollLeft > margin,
    right: hasOverflow && scrollLeft + clientWidth < scrollWidth - margin,
  }
}
