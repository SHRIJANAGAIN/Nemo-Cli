/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
