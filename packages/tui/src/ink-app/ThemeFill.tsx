/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"

/**
 * Background fill for regions with no text in them.
 *
 * Ink paints a Box background only on rows it actually writes, and a row
 * holding no text is never written — so an empty area of the frame keeps
 * showing the TERMINAL's own backdrop, not the theme's. That is why a themed
 * app still looked black-on-black: only the text-bearing rows took the theme
 * colour.
 *
 * A row of spaces IS a written row, so rendering `rows` full-width space
 * lines with the theme background fills the region for real. Cost is bounded
 * (one Text per row, no colour work at render time) and it is the only way to
 * get a themed canvas out of Ink's row model.
 */
export function ThemeFill({ rows, background, width }: { rows: number; background: string; width: number }): ReactNode {
  const count = Math.max(0, Math.min(rows, 200))
  if (count === 0) return null
  const line = " ".repeat(Math.max(1, Math.min(width, 400)))
  return (
    <Box flexDirection="column" flexShrink={0}>
      {Array.from({ length: count }, (_, i) => (
        <Text key={i} backgroundColor={background}>
          {line}
        </Text>
      ))}
    </Box>
  )
}

export default ThemeFill