/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export type ModeName = "default" | "plan" | "architect" | "code" | "debug" | "review"

export interface ModeOptions {
  readonly action: "list" | "current" | "set"
  readonly mode?: ModeName
}

const MODES: ModeName[] = ["default", "plan", "architect", "code", "debug", "review"]

/**
 * The selected mode persists here (round 13). `set` used to answer
 * "Mode set to: X" while NOTHING stored it and `current` always said
 * "default" — an acknowledgement nobody could ever observe. Invalid or
 * missing file falls back to "default" (never throws on bad user state).
 */
const MODE_FILE = path.join(os.homedir(), ".nemo", "mode.json")

function readStoredMode(): ModeName {
  try {
    if (fs.existsSync(MODE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MODE_FILE, "utf8")) as { mode?: unknown }
      if (typeof parsed.mode === "string" && (MODES as string[]).includes(parsed.mode)) {
        return parsed.mode as ModeName
      }
    }
  } catch {
    /* corrupt/unreadable → default */
  }
  return "default"
}

function writeStoredMode(mode: ModeName): void {
  try {
    fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true })
    fs.writeFileSync(MODE_FILE, `${JSON.stringify({ mode }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  } catch {
    // A read-only home must not turn a `mode set` into a crash — the
    // command still reports what was requested; only persistence is lost.
  }
}

export function modeCommand(options: ModeOptions): string {
  switch (options.action) {
    case "list": {
      return `Available modes:\n` + MODES.map((m) => `  - ${m}`).join("\n")
    }
    case "current": {
      return `Current mode: ${readStoredMode()}`
    }
    case "set": {
      if (!options.mode) return "Missing mode"
      if (!MODES.includes(options.mode)) return `Unknown mode: ${options.mode}. Available: ${MODES.join(", ")}`
      writeStoredMode(options.mode)
      return `Mode set to: ${options.mode}`
    }
    default:
      return `Unknown mode action: ${options.action}`
  }
}
