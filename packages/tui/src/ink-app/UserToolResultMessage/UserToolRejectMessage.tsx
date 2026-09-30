/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import React, { type ReactNode } from "react"
import { MessageResponse } from "../MessageResponse.js"
import { UserToolCanceledMessage } from "./UserToolCanceledMessage.js"

export const UserToolRejectMessage = (): ReactNode => {
  return (
    <MessageResponse height={1}>
      <UserToolCanceledMessage />
    </MessageResponse>
  )
}

export default UserToolRejectMessage
