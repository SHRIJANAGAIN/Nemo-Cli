/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { useMemo, type ReactNode } from "react"
import { Box, Text } from "ink"

interface Props {
  result?: string
  verbose?: boolean
  width?: number | string
}

const MAX_RENDERED_LINES = 15
const MAX_RESULT_LENGTH = 2000

export const UserToolSuccessMessage = ({ result, verbose = false, width }: Props): ReactNode => {
  const displayedResult = useMemo(() => {
    if (!result) return null
    if (verbose) return result

    if (result.length > MAX_RESULT_LENGTH) {
      return result.slice(0, MAX_RESULT_LENGTH) + "…"
    }
    return result
  }, [result, verbose])

  const displayedLines = useMemo(() => {
    if (!displayedResult) return []
    const lines = displayedResult.split("\n")
    if (verbose || lines.length <= MAX_RENDERED_LINES) return lines
    return lines.slice(0, MAX_RENDERED_LINES)
  }, [displayedResult, verbose])

  const plusLines = displayedResult ? displayedResult.split("\n").length - MAX_RENDERED_LINES : 0

  if (!displayedResult) {
    return null
  }

  return (
    <Box flexDirection="column" width={width}>
      <Box flexDirection="column">
        {displayedLines.map((line, idx) => (
          <Text key={`result-line-${idx}`}>{line}</Text>
        ))}
      </Box>
      {!verbose && plusLines > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            {"… +"}
            {plusLines} {plusLines === 1 ? "line" : "lines"}
            {" (Ctrl+O for full)"}
          </Text>
        </Box>
      )}
    </Box>
  )
}

export default UserToolSuccessMessage
