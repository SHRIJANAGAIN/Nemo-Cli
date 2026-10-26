/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
