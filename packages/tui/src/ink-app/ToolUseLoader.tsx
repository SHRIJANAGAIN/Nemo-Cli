/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode, useState, useEffect } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"

const BLACK_CIRCLE = "?"

const BLINK_INTERVAL_MS = 600

export interface ToolUseLoaderProps {
  isError?: boolean
  isUnresolved?: boolean
  shouldAnimate?: boolean
  status?: "pending" | "running" | "completed" | "error"
}

export const ToolUseLoader = ({
  isError = false,
  isUnresolved = true,
  shouldAnimate = true,
  status,
}: ToolUseLoaderProps): ReactNode => {
  const theme = useThemeColors()
  const [isVisible, setIsVisible] = useState(true)

  useEffect(() => {
    if (!shouldAnimate || (status !== "running" && status !== undefined)) return

    const interval = setInterval(() => {
      setIsVisible((v) => !v)
    }, BLINK_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [shouldAnimate, status])

  let color: string | undefined
  let dimColor: boolean | undefined

  if (status === "completed") {
    color = theme.success
  } else if (status === "error") {
    color = theme.error
  } else if (isUnresolved) {
    dimColor = true
  } else if (isError) {
    color = theme.error
  } else {
    color = theme.success
  }

  // Blink ? ? space. The pre-fix expression returned the raw BOOLEAN
  // `isVisible` — React/Ink render booleans as NOTHING, so a running tool
  // call showed an empty 2-col gutter and no animation at all ("must have
  // tool call animation, old to future"). A string keeps the box width
  // stable while the dot blinks. Affects every caller (ToolCallItem,
  // ExecToolCallItem, MCPToolCallItem).
  const isBlinking = shouldAnimate && (status === "running" || status === undefined)
  const showDot = isBlinking ? (isVisible ? BLACK_CIRCLE : " ") : BLACK_CIRCLE

  return (
    <Box minWidth={2}>
      {/* "animation bada do": the RUNNING bullet renders bold + undimmed —
          the old dim ? faded into the header and read as a static speck.
          Blink-off frames are " " (width-stable), and finished/queued
          dots keep their exact colours. */}
      <Text color={color} dimColor={dimColor && !isBlinking} bold={isBlinking}>
        {showDot}
      </Text>
    </Box>
  )
}

export default ToolUseLoader
