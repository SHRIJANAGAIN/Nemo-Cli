/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * `trayambak uninstall` — reverse install.sh / install-global.js.
 *
 * Removes the launcher shims (~/bin/*.cmd + TRAYAMBAK_HOME on Windows,
 * ~/.local/bin/* on POSIX) and nothing else: config (~/.trayambak),
 * sessions, and state are left untouched on purpose. npm-global installs
 * are reported, not removed (`npm rm -g` stays the owner's call).
 */

import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface UninstallSeams {
  /** Home directory to clean (default: os.homedir()). */
  homeDir?: string
  /** Platform override (default: process.platform). */
  platform?: NodeJS.Platform
  /** setx runner (default: real spawnSync). Returns the exit status. */
  setx?: (args: string[]) => number
}

function defaultSetx(args: string[]): number {
  try {
    const result = spawnSync("setx", args, { windowsHide: true, timeout: 15_000 })
    if (result.error) return 1
    return result.status ?? 1
  } catch {
    return 1
  }
}

/** `trayambak uninstall`: remove launcher shims, keep data. */
export function uninstallCommand(seams: UninstallSeams = {}): string {
  const home = seams.homeDir ?? homedir()
  const platform = seams.platform ?? process.platform
  const lines: string[] = []

  if (platform === "win32") {
    for (const shim of ["trayambak.cmd", "skt.cmd"]) {
      const file = join(home, "bin", shim)
      if (existsSync(file)) {
        rmSync(file, { force: true })
        lines.push(`removed shim: ${file}`)
      } else {
        lines.push(`shim not found (skipped): ${file}`)
      }
    }
    // An empty setx value DELETES the variable.
    const setx = seams.setx ?? defaultSetx
    lines.push(
      setx(["TRAYAMBAK_HOME", ""]) === 0 ? "cleared TRAYAMBAK_HOME" : "could not clear TRAYAMBAK_HOME (already gone?)",
    )
  } else {
    for (const name of ["trayambak", "skt"]) {
      const file = join(home, ".local", "bin", name)
      if (existsSync(file)) {
        rmSync(file, { force: true })
        lines.push(`removed shim: ${file}`)
      } else {
        lines.push(`shim not found (skipped): ${file}`)
      }
    }
  }

  lines.push("kept: config, sessions, and state under ~/.trayambak")
  lines.push("npm-global installs: run `npm rm -g @skt-ai-labs/trayambak-cli` to remove the package itself")
  return lines.join("\n")
}
