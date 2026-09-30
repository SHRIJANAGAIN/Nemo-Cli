/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode } from "react"
import { Text } from "ink"
import { MessageResponse } from "../MessageResponse.js"

export const UserToolCanceledMessage = (): ReactNode => {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Tool execution was canceled.</Text>
    </MessageResponse>
  )
}

export default UserToolCanceledMessage
