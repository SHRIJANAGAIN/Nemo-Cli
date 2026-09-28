/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { useContext, type ReactNode } from "react"
import { Box, Text } from "ink"

interface Props {
  children: ReactNode
  height?: number
}

const MessageResponseContext = React.createContext<boolean>(/*defaultValue*/ false)

function MessageResponseProvider({ children }: { children: ReactNode }): ReactNode {
  return <MessageResponseContext.Provider value={true}>{children}</MessageResponseContext.Provider>
}

export function MessageResponse({ children, height }: Props): ReactNode {
  const isMessageResponse = useContext(MessageResponseContext)
  if (isMessageResponse) {
    return children
  }

  // overflow (not overflowY — ink Box has no overflowY, so the old prop was
  // silently ignored and over-tall content pushed the frame past the
  // terminal). The height if/else below was dead (both arms returned the
  // same tree) — height flows straight into the Box.
  return (
    <MessageResponseProvider>
      <Box flexDirection="row" height={height} overflow="hidden">
        <Box flexShrink={0}>
          <Text dimColor>{"  "}⎿ </Text>
        </Box>
        <Box flexShrink={1} flexGrow={1}>
          {children}
        </Box>
      </Box>
    </MessageResponseProvider>
  )
}
