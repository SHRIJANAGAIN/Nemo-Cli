/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { createContext, useContext } from "react"

export interface ScrollContextValue {
  scrollDomToBottom: () => void
}

const ScrollContext = createContext<ScrollContextValue>({
  scrollDomToBottom: () => {},
})

export function useScrollContext(): ScrollContextValue {
  return useContext(ScrollContext)
}

export { ScrollContext }
