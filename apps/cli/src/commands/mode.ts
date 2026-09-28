/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export type ModeName = "default" | "plan" | "architect" | "code" | "debug" | "review"

export interface ModeOptions {
  readonly action: "list" | "current" | "set"
  readonly mode?: ModeName
}

const MODES: ModeName[] = ["default", "plan", "architect", "code", "debug", "review"]

export function modeCommand(options: ModeOptions): string {
  switch (options.action) {
    case "list": {
      return `Available modes:\n` + MODES.map((m) => `  - ${m}`).join("\n")
    }
    case "current": {
      return `Current mode: default`
    }
    case "set": {
      if (!options.mode) return "Missing mode"
      if (!MODES.includes(options.mode)) return `Unknown mode: ${options.mode}. Available: ${MODES.join(", ")}`
      return `Mode set to: ${options.mode}`
    }
    default:
      return `Unknown mode action: ${options.action}`
  }
}
