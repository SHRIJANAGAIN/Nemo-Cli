/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { TrayambakConfig } from "../../../../apps/runtime/src/config"

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
  const TrayambakApp: React.ComponentType<any> = appMod.TrayambakApp

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
