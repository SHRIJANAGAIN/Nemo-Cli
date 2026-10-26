/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export interface ToolsetDefinition {
  name: string
  description: string
  toolNames: string[]
  checkFn?: () => boolean | Promise<boolean>
}

export interface ArsenalConfig {
  defaultToolsets: string[]
  disabledToolsets: string[]
  platformToolsets?: Record<string, string[]>
}

export const DEFAULT_TOOLSETS = ["core"]
export const DEFAULT_ARSENAL_CONFIG: ArsenalConfig = {
  defaultToolsets: DEFAULT_TOOLSETS,
  disabledToolsets: [],
  platformToolsets: {},
}
