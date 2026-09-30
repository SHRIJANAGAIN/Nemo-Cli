/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { MessageResponse } from "../MessageResponse.js"

interface Props {
  result?: string
  verbose?: boolean
}

const MAX_RENDERED_LINES = 10

export const UserToolErrorMessage = ({ result, verbose }: Props): ReactNode => {
  let error: string

  if (!result) {
    error = "Tool execution failed"
  } else {
    error = result.trim()
  }

  const plusLines = error.split("\n").length + 1 - MAX_RENDERED_LINES

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="red">{verbose ? error : error.split("\n").slice(0, MAX_RENDERED_LINES).join("\n")}</Text>
        {!verbose && plusLines > 0 && (
          <Text dimColor>
            {" … +"}
            {plusLines} {plusLines === 1 ? "line" : "lines"}
            {" (Ctrl+O for full)"}
          </Text>
        )}
      </Box>
    </MessageResponse>
  )
}

export default UserToolErrorMessage
