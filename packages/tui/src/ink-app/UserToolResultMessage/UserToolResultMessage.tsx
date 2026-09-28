/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import React, { type ReactNode } from "react"
import { UserToolCanceledMessage } from "./UserToolCanceledMessage.js"
import { UserToolErrorMessage } from "./UserToolErrorMessage.js"
import { UserToolRejectMessage } from "./UserToolRejectMessage.js"
import { UserToolSuccessMessage } from "./UserToolSuccessMessage.js"

interface Props {
  isError?: boolean
  isCanceled?: boolean
  isRejected?: boolean
  result?: string
  verbose?: boolean
  width?: number | string
}

export const UserToolResultMessage = ({
  isError = false,
  isCanceled = false,
  isRejected = false,
  result,
  verbose,
  width,
}: Props): ReactNode => {
  if (isCanceled) {
    return <UserToolCanceledMessage />
  }

  if (isRejected) {
    return <UserToolRejectMessage />
  }

  if (isError) {
    return <UserToolErrorMessage result={result} verbose={verbose} />
  }

  return <UserToolSuccessMessage result={result} verbose={verbose} width={width} />
}

export default UserToolResultMessage
