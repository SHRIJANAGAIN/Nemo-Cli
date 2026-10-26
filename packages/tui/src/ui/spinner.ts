/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { getTheme, fg, RESET, type Rgb, type Theme } from "./theme.js"

/** Braille dot spinner frames (b' style). */
export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Arc frames for a smoother feel in headers. */
export const ARC_FRAMES = ["◜", "◠", "◝", "◞", "◡", "◟"]

/** Linear scanner gradient spinner — walks a highlight across a label. */
export function gradientScanner(label: string, frame: number, colors: Rgb[]): string {
  const theme = getTheme()
  const cols = colors.length > 0 ? colors : [theme.primary as Rgb]
  const n = [...label].length
  if (n === 0) return label
  const pos = frame % (n * 2)
  const active = pos < n ? pos : n * 2 - 1 - pos
  let out = ""
  ;[...label].forEach((ch, i) => {
    const dist = Math.abs(i - active)
    const color = cols[Math.min(dist, cols.length - 1)] ?? (theme.primary as Rgb)
    out += fg(color) + ch
  })
  return out + RESET
}

/** Classic spinner state: pick frame + paint it with a theme token. */
export function spinnerFrame(frame: number, token: keyof Theme = "primary"): string {
  const theme = getTheme()
  const ch = BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length]
  return fg(theme[token] as Rgb) + ch + RESET
}

/**
 * Animated tool-run spinner: cycling glyphs with rotating colors, then
 * letter-spelled "NEMO CODE", then settles on </> (matches run.ts loop).
 */
export const TOOL_GLYPHS = ["<", "/", "-", ">", "~", "x", "s", "y", "@", "#", "^"]
export const TOOL_COLORS: Array<keyof Theme> = ["primary", "info", "success", "error", "primary", "info"]

export function toolSpinnerGlyph(frame: number): string {
  const theme = getTheme()
  const glyph = TOOL_GLYPHS[frame % TOOL_GLYPHS.length]
  const token = TOOL_COLORS[Math.floor(frame / TOOL_GLYPHS.length) % TOOL_COLORS.length]
  return fg(theme[token] as Rgb) + glyph + RESET
}

export function toolSpinnerLabel(frame: number): string {
  const word = "NEMO CODE"
  const phase = Math.floor(frame / TOOL_GLYPHS.length)
  if (phase < word.length) return word.slice(0, phase)
  return word
}

/** Wave-shimmer level per character: a hot spot travels one char per frame
 *  across the label and wraps around. Pure (no Ink) so it unit-tests
 *  without a renderer. 2 = hot, 1 = warm, 0 = dim. */
export type WaveLevel = 0 | 1 | 2

export function waveLevels(length: number, frame: number, wavelength = 6): WaveLevel[] {
  if (length <= 0 || wavelength <= 0) return []
  const out: WaveLevel[] = []
  for (let i = 0; i < length; i++) {
    const phase = ((((i - frame) % wavelength) + wavelength) % wavelength) + 1
    out.push(phase === 1 ? 2 : phase === 2 || phase === wavelength ? 1 : 0)
  }
  return out
}
