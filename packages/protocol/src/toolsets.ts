/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
