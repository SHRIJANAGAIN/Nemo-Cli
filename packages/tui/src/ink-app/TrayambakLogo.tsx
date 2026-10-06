/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import fs from "node:fs"
import path from "node:path"
import React, { type ReactNode } from "react"
import { Box, Text } from "ink"
import { logoGradient, useThemeColors } from "./themeColors.js"

export interface TrayambakLogoProps {
  compact?: boolean
  /** Frame width in cells. Used to pad the banner rows out with the theme
   *  background so no terminal-black box shows beside the mark (see
   *  padLogoToTheme). 0 disables the padding. */
  width?: number
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
  // Strip CR before trimEnd: the loader previously did only trimEnd(), which
  // drops the FINAL CRLF but leaves every interior one in the art. This repo
  // has core.autocrlf=true, so a fresh checkout ships logo_ansi.txt with CRLF
  // line endings — and Ink writes the art verbatim. Each stray \r rewinds the
  // cursor to column 0 mid-line, so the following padding erases the frame's
  // left │ wall and plants a lone │ in the middle of every logo row. Observed
  // live exactly like that; the art itself contains no box-drawing glyphs, so
  // a \r in the payload is the only way it can happen.
  return fs.readFileSync(assetPath, "utf8").replace(/\r/g, "").trimEnd()
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

/** Does the loaded banner already carry its own SGR palette? */
export function hasAnsi(art: string): boolean {
  return art.includes("\x1b[")
}

/** "#0a0a0a" → "0;10;10" (SGR triplet form). Returns null for unusable input. */
export function hexToSgr(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`
}

const stripSgr = (line: string): string => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")

/** Visible cell count of one banner row (SGR stripped, trailing spaces dropped). */
const visibleCells = (line: string): number =>
  [...stripSgr(line).replace(/\s+$/, "")].length

/**
 * Pad every banner row out to `width` cells using the ACTIVE THEME's
 * background colour.
 *
 * This is what removes the black box around the mark. The art is a ▀ raster
 * that sets its own background per cell and closes each row with a reset, so
 * everything after the last cell falls back to the TERMINAL's default
 * backdrop — black — regardless of the theme. Ink only writes as many columns
 * as the content has, so the untouched remainder of those rows showed through
 * as a black rectangle once the frame started painting a themed canvas.
 *
 * Filling the remainder explicitly with the theme colour makes the banner rows
 * genuinely part of the frame. Runs that already reach `width` are untouched.
 */
export function padLogoToTheme(art: string, backgroundHex: string, width: number): string {
  const sgr = hexToSgr(backgroundHex)
  // One cell of slack: padding to EXACTLY the available width makes Ink's
  // truncator append an ellipsis (content == maxWidth still trips it), which
  // drew a stray "…" at the end of every banner row.
  const target = width - 1
  if (!sgr || target <= 0) return art
  return art
    .split("\n")
    .map((line) => {
      // Split off the row-closing reset FIRST: the banner's trailing spaces sit
      // BEFORE it, so a `$`-anchored trim never matched them. Keeping them and
      // appending the themed fill on top ran each row long by exactly their
      // count (26 + 22 + 87 = 135 cells on a 114-wide frame) and pushed every
      // row into truncation — the stray "…" on each line.
      const closer = /\x1b\[0m$/.exec(line)
      const body = closer ? line.slice(0, closer.index) : line
      const reset = closer ? "\x1b[0m" : ""
      const trimmed = body.replace(/[ \t]+$/, "")
      const fill = target - visibleCells(trimmed)
      if (fill <= 0) return `${trimmed}${reset}`
      return `${trimmed}\x1b[48;2;${sgr}m${" ".repeat(fill)}${reset}`
    })
    .join("\n")
}

export function TrayambakLogo({ compact = false, width = 0 }: TrayambakLogoProps): ReactNode {
  const theme = useThemeColors()

  if (compact) {
    return (
      <Text color={theme.primary} bold>
        TRAYAMBAK
      </Text>
    )
  }

  const logo = getLogo()
  if (!logo) {
    return null
  }

  // The canonical `logo_ansi.txt` bakes its own palette into the art, so it
  // renders verbatim. Only the monochrome fallback gets painted here — left
  // alone it renders flat default-foreground and ignores the active /theme.
  //
  // Width discipline: the art is ~41 cells, but every one of its cells carries
  // its own 24-bit SGR pair. Those dense rows are where Windows Terminal's
  // ConPTY has been seen tearing the surrounding frame (walls lost on the logo
  // rows only), so the art renders inside a full-width box: left-aligned as the
  // banner's own raster intends, but resolving its truncate against the frame
  // so it can never overflow and claim a border column.
  if (hasAnsi(logo)) {
    // One Text PER ROW, never a single multi-line Text. Ink routes a
    // multi-line Text through cli-truncate, which collapses the whole banner
    // to its first row (observed: 11-row logo rendering as a single stub with
    // a trailing ellipsis). Per-row Texts also let each row be padded to the
    // theme background independently.
    return (
      <Box flexDirection="column" width="100%">
        {padLogoToTheme(logo, theme.background, width)
          .split("\n")
          .map((line, index) => (
            <Text key={index} wrap="truncate">
              {line}
            </Text>
          ))}
      </Box>
    )
  }

  const lines = logo.split("\n")
  const gradient = logoGradient(theme, lines.length)
  return (
    <Box flexDirection="column" width="100%">
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate" color={gradient[index]}>
          {line}
        </Text>
      ))}
    </Box>
  )
}

export default TrayambakLogo
