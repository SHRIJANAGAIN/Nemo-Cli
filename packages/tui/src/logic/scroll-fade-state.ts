/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
