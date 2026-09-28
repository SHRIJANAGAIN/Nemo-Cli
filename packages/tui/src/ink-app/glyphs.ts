/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Central glyph table for the Ink TUI.
 *
 * All status glyphs in user-visible output MUST come from here via `g()`.
 * Unicode is the default everywhere (●○◌✓✗★❯█⚠ + braille spinners).
 * Opt out per terminal: TRAYAMBAK_GLYPHS=ascii forces the ASCII set
 * (`* o - v x ! > _` + pipe spinner) for consoles whose fonts lack the
 * Unicode marks. TRAYAMBAK_GLYPHS=unicode forces Unicode.
 */

export type GlyphSet = "unicode" | "ascii"

export type GlyphName =
  | "dot"
  | "ring"
  | "spinnerDot"
  | "ok"
  | "fail"
  | "warn"
  | "star"
  | "caret"
  | "prompt"
  | "picker"
  | "bullet"
  | "caretDown"
  | "caretUp"

const UNICODE: Record<GlyphName, string> = {
  dot: "●",
  ring: "○",
  spinnerDot: "◌",
  ok: "✓",
  fail: "✗",
  warn: "⚠",
  star: "★",
  caret: "█",
  prompt: "❯",
  picker: "❯",
  bullet: "•",
  caretDown: "▼",
  caretUp: "▲",
}

const ASCII: Record<GlyphName, string> = {
  dot: "*",
  ring: "o",
  spinnerDot: "-",
  ok: "v",
  fail: "x",
  warn: "!",
  star: "*",
  caret: "_",
  prompt: ">",
  picker: ">",
  bullet: "-",
  caretDown: "v",
  caretUp: "^",
}

let cached: GlyphSet | null = null

export function glyphSet(): GlyphSet {
  if (cached) return cached
  const env = (process.env.TRAYAMBAK_GLYPHS ?? "").trim().toLowerCase()
  if (env === "ascii" || env === "plain") return (cached = "ascii")
  return (cached = "unicode")
}

/** Test hook: clear the cached detection result. */
export function resetGlyphCache(): void {
  cached = null
}

/** The glyph for `name` in the active set. Every glyph is width-1 in both sets. */
export function g(name: GlyphName): string {
  return (glyphSet() === "ascii" ? ASCII : UNICODE)[name]
}

/** Braille spinner frames (Unicode) / pipe spinner (ASCII). */
export function spinnerFrames(): string[] {
  if (glyphSet() === "ascii") return ["|", "/", "-", "\\"]
  return ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
}
