/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { SlashCommandRegistry } from "./registry.js"
import { buildTrayambakSlashRegistry, formatHelp, dispatchSlashCommandAsync } from "./command-dispatch.js"
import { loadConfig } from "../../../runtime/src/index.js"

export interface SlashCommandInterface {
  readonly registry: SlashCommandRegistry
  readonly dispatch: (input: string) => Promise<string>
  readonly help: () => string
}

export class SlashCommandService implements SlashCommandInterface {
  readonly registry: SlashCommandRegistry

  constructor() {
    this.registry = buildTrayambakSlashRegistry()
  }

  dispatch(input: string): Promise<string> {
    const config = loadConfig()
    return dispatchSlashCommandAsync(this.registry, input, config).then((r) => r.output)
  }

  help(): string {
    return formatHelp(this.registry)
  }
}

export const slashCommandService = new SlashCommandService()
