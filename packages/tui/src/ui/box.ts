/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  getTheme,
  fg,
  bg,
  RESET,
  BOLD,
  paint,
  paintBg,
  stripAnsi,
  visibleLen,
  type Theme,
  type Rgb,
  selectedForeground,
} from "./theme"
import { RoundedBorder, SharpBorder, DoubleBorder, EmptyBorder, SplitBorder } from "./border"

export type BorderStyle = "rounded" | "sharp" | "double" | "none" | "split"

function borderChars(style: BorderStyle) {
  switch (style) {
    case "rounded":
      return RoundedBorder
    case "double":
      return DoubleBorder
    case "split":
      return { ...EmptyBorder, vertical: SplitBorder.chars.vertical }
    case "none":
      return EmptyBorder
    default:
      return SharpBorder
  }
}

// Width math goes through visibleLen (npm string-width — grapheme/ANSI
// aware, same module Ink wraps with). Raw `.length` counted UTF-16 units:
// Devanagari matras/virama live inside the base glyph's cell, so Hindi
// lines measured long, pads came out short and the right border drifted
// left mid-word ("words looked broken").
function padTo(line: string, width: number): string {
  const len = visibleLen(line)
  return len >= width ? line : line + " ".repeat(width - len)
}

function wordWrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const raw of text.split("\n")) {
    if (visibleLen(raw) <= width) {
      out.push(raw)
      continue
    }
    let cur = ""
    for (const word of raw.split(/ /)) {
      if (visibleLen(cur) + visibleLen(word) + 1 > width && cur) {
        out.push(cur)
        cur = word
      } else cur = cur ? cur + " " + word : word
    }
    if (cur) out.push(cur)
  }
  return out
}

export type BoxOptions = {
  title?: string
  border?: BorderStyle
  borderColor?: keyof Theme
  titleColor?: keyof Theme
  paddingX?: number
  paddingY?: number
  width?: number
  maxWidth?: number
  bgColor?: keyof Theme
}

/** Render a bordered, padded, word-wrapped box — the core dialog primitive. */
export function renderBox(content: string, options: BoxOptions = {}): string {
  const theme = getTheme()
  const style = options.border ?? "rounded"
  const bc = borderChars(style)
  const borderToken = (options.borderColor ?? "border") as keyof Theme
  const padX = options.paddingX ?? 1
  const padY = options.paddingY ?? 0
  const termWidth = Math.max(40, process.stdout.columns ?? 100)
  const innerWidth = Math.max(8, (options.width ?? Math.min(options.maxWidth ?? 84, termWidth - 4)) - 2 - padX * 2)

  const lines = wordWrap(content, innerWidth).map((l) => " ".repeat(padX) + padTo(l, innerWidth) + " ".repeat(padX))
  const blank = " ".repeat(innerWidth + padX * 2)
  for (let i = 0; i < padY; i++) {
    lines.unshift(blank)
    lines.push(blank)
  }

  const bcColor = theme[borderToken] as Rgb
  const bcol = fg(bcColor)
  const bgCol = options.bgColor ? bg(theme[options.bgColor] as Rgb) : ""

  const top = options.title
    ? bcol +
      (bc.topLeft + bc.horizontal.repeat(2) + " ") +
      RESET +
      paint(options.titleColor ?? borderToken, options.title, BOLD) +
      " " +
      bcol +
      bc.horizontal.repeat(Math.max(0, innerWidth + padX * 2 - visibleLen(options.title) - 4)) +
      bc.topRight +
      RESET
    : bcol + bc.topLeft + bc.horizontal.repeat(innerWidth + padX * 2) + bc.topRight + RESET

  const body = lines.map(
    (l) =>
      bgCol + bcol + (bc.vertical || " ") + RESET + bgCol + l + RESET + bgCol + bcol + (bc.vertical || " ") + RESET,
  )

  const bottom = bcol + bc.bottomLeft + bc.horizontal.repeat(innerWidth + padX * 2) + bc.bottomRight + RESET

  return [top, ...body, bottom].join("\n")
}

/** A single highlighted select-row (used by select dialogs and palettes). */
export function renderSelectRow(label: string, description: string | undefined, selected: boolean): string {
  const theme = getTheme()
  const cursor = selected ? paint("primary", "❯", BOLD) : " "
  if (selected) {
    const selFg = fg(selectedForeground())
    const row = " " + padTo(stripAnsi(label) + (description ? "  " + description : ""), 70)
    return `${cursor}${bg(theme.primary as Rgb)}${selFg}${row}${RESET}`
  }
  return `${cursor} ${paint("text", label)}${description ? paint("textMuted", "  " + description) : ""}`
}

/** Horizontal rule spanning the terminal width. */
export function renderRule(token: keyof Theme = "borderSubtle"): string {
  const width = Math.max(20, process.stdout.columns ?? 100)
  return paint(token, "─".repeat(width))
}

/** Key-value status row. */
export function renderKvRow(key: string, value: string, valueToken: keyof Theme = "text"): string {
  return paint("textMuted", padTo(key, 16)) + paint(valueToken, value)
}

export { RoundedBorder, SharpBorder, DoubleBorder, EmptyBorder, SplitBorder, paint, paintBg, selectedForeground }
