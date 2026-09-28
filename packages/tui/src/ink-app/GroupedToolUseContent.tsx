/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { ToolCallItem } from "./ToolCallItem.js"
import type { ToolCallDisplay } from "./types.js"
import { useThemeColors } from "./themeColors.js"

export interface GroupedToolUseProps {
  toolName: string
  toolCalls: ToolCallDisplay[]
  shouldAnimate?: boolean
}

export const GroupedToolUseContent = ({
  toolName,
  toolCalls,
  shouldAnimate = false,
}: GroupedToolUseProps): ReactNode => {
  const theme = useThemeColors()
  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text bold color={theme.primary}>
        Using {toolName} ({toolCalls.length} calls)
      </Text>
      {toolCalls.map((call) => (
        <ToolCallItem
          key={call.id}
          toolCall={call}
          shouldAnimate={shouldAnimate}
          shouldShowDot={true}
          addMargin={false}
        />
      ))}
    </Box>
  )
}

export default GroupedToolUseContent
