/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { TrayambakConfig } from "../../../../apps/runtime/src/config.js"

export interface InkReplOptions {
  config: TrayambakConfig
  prompt?: string
  sessionFile?: string
  sessionId?: string
  onExit?: () => void
}

export async function startInkRepl(options: InkReplOptions): Promise<void> {
  const [inkMod, reactMod, appMod] = await Promise.all([import("ink"), import("react"), import("../ink-app/index.js")])

  const { render } = inkMod
  const { createElement } = reactMod
  const TrayambakApp = appMod.TrayambakApp

  render(
    createElement(TrayambakApp, {
      config: options.config,
      modelName: options.config.model,
      permissionMode: "ask",
      onExit: options.onExit,
    }),
    {
      stdin: process.stdin,
      stdout: process.stdout,
    },
  )
}
