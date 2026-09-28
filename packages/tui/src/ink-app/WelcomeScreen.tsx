/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { useEffect, useState, type ReactNode } from "react"
import { Box, Text } from "ink"
import { useThemeColors } from "./themeColors.js"
import { TrayambakLogo } from "./TrayambakLogo.js"

export interface WelcomeScreenProps {
  modelName?: string
  permissionMode?: string
  cwd?: string
  tokenCount?: number
}

/** Idle-home animation: the welcome line breathes through the brand hues
 *  (~0.5 s per step) so the first screen isn't a frozen poster. Content
 *  never changes — only the colour — so width/oracles stay exact. */
const WELCOME_CYCLE_MS = 500

export function WelcomeScreen(): ReactNode {
  const theme = useThemeColors()
  const [hue, setHue] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setHue((h) => h + 1), WELCOME_CYCLE_MS)
    return () => clearInterval(timer)
  }, [])
  const welcomeColors = [theme.info, theme.primary, theme.accent, theme.success]
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="column" alignItems="center">
        <TrayambakLogo compact={false} />
      </Box>

      <Box flexDirection="column" alignItems="center" marginTop={1}>
        <Text bold color={welcomeColors[hue % welcomeColors.length]}>
          Welcome To Trayambak CLI
        </Text>
      </Box>
    </Box>
  )
}

export default WelcomeScreen
