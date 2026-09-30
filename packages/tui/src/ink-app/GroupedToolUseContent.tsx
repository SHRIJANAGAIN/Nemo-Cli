/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
