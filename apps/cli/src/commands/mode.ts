/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
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
