/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import fs from "node:fs"
import path from "node:path"
import React, { type ReactNode } from "react"
import { Box, Text } from "ink"

export interface TrayambakLogoProps {
  compact?: boolean
}

function loadLogo(): string {
  // Deterministic order: explicit override, then the canonical logo sitting
  // next to this module (resolves in source ink-app/, CJS ink-app/, and the
  // flattened ink-app-esm/ alike), then well-known repo locations. The legacy
  // cwd-relative assets come last — they used to rank ABOVE the canonical
  // logo, so some launch contexts showed a different logo than others.
  const candidates = [
    process.env.TRAYAMBAK_LOGO_PATH ?? "",
    typeof __dirname === "string" ? path.join(__dirname, "logo_ansi.txt") : "",
    typeof __dirname === "string" ? path.join(__dirname, "trayambak-logo.txt") : "",
    process.env.TRAYAMBAK_HOME
      ? path.join(process.env.TRAYAMBAK_HOME, "dist", "packages", "tui", "src", "ink-app-esm", "logo_ansi.txt")
      : "",
    process.env.TRAYAMBAK_HOME
      ? path.join(process.env.TRAYAMBAK_HOME, "packages", "tui", "src", "ink-app", "logo_ansi.txt")
      : "",
    path.join(process.cwd(), "packages", "tui", "src", "ink-app", "logo_ansi.txt"),
    path.join(process.cwd(), "dist", "packages", "tui", "src", "ink-app", "logo_ansi.txt"),
    path.join(process.cwd(), "dist", "packages", "tui", "src", "ink-app-esm", "logo_ansi.txt"),
    path.join(process.cwd(), "trayambak", "dist", "packages", "tui", "src", "ink-app-esm", "logo_ansi.txt"),
    path.join(process.cwd(), "assets", "trayambak-logo.txt"),
    path.join(process.cwd(), "assets", "skt-logo.txt"),
  ].filter(Boolean)
  const assetPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!assetPath) {
    // Never crash the whole TUI over a decorative banner: render no logo.
    return ""
  }
  return fs.readFileSync(assetPath, "utf8").trimEnd()
}

let logoCache: string | undefined
function getLogo(): string {
  // Lazy so ink-repl.mjs's TRAYAMBAK_LOGO_PATH default (assigned after this
  // module graph is evaluated) actually takes effect: official launches then
  // resolve the same canonical logo regardless of the working directory.
  if (logoCache === undefined) {
    logoCache = loadLogo()
  }
  return logoCache
}

/** Line count of the active banner (0 when absent) — lets overlays budget
 *  their height BEFORE rendering (the file banner is 10 lines; a missing
 *  logo renders null, and callers must not assume either). */
export function logoLineCount(): number {
  const logo = getLogo()
  return logo ? logo.split("\n").length : 0
}

export function TrayambakLogo({ compact = false }: TrayambakLogoProps): ReactNode {
  if (compact) {
    return (
      <Text color="#00ff00" bold>
        TRAYAMBAK
      </Text>
    )
  }

  const logo = getLogo()
  if (!logo) {
    return null
  }

  return (
    <Box flexDirection="column" alignItems="flex-start">
      {/* truncate, never wrap: ASCII/ANSI art has spaceless block runs
          (▀/░▒▓█) that word-wrap tears into stairs at narrow widths, and a
          centered wide logo overflows both sides. Clipping one side keeps
          the mark recognizable at any width. */}
      <Text wrap="truncate">{logo}</Text>
    </Box>
  )
}

export default TrayambakLogo
