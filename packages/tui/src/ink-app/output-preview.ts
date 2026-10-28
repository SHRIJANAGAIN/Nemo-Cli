/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Bounded previews of command output.
 *
 * Ported in behaviour from codex-rs `tui/src/exec_cell/live_output.rs`, which
 * keeps the FIRST and LAST `MAX_LINES` completed lines and abbreviates every
 * retained line to a prefix plus a suffix "so commands that never emit a newline
 * cannot grow the active cell without bound". Nemo only kept the first N
 * lines and truncated each to a head, which has two failure modes users actually
 * hit: a build that ends in an error shows the error nowhere in the preview (the
 * interesting half of `npm test` output is the tail), and a progress bar that
 * repaints with `\r` and never emits `\n` arrives as ONE enormous line.
 */

import { graphemes, stringWidth } from "./utils/stringWidth.js"

/** Lines kept from the top of a long output. */
export const PREVIEW_HEAD_LINES = 8
/** Lines kept from the bottom — where failures live. */
export const PREVIEW_TAIL_LINES = 8
/** Cells kept at each end of an over-long line. */
const LINE_HEAD_COLS = 60
const LINE_TAIL_COLS = 40

export interface OutputPreviewOptions {
  headLines?: number
  tailLines?: number
  headCols?: number
  tailCols?: number
}

export interface OutputPreview {
  /** The lines to render, already abbreviated. */
  lines: string[]
  /** How many lines sat between the head and the tail and were dropped. */
  hidden: number
  /** True when the output ended mid-line (a command still streaming). */
  partial: boolean
}

/** Split output into display lines, resolving `\r` the way a terminal does.
 *  A carriage return repaints the current line, so only the LAST segment of a
 *  `\r`-separated run is ever visible — keeping the others (or concatenating
 *  them, which is what stripping every `\r` did) invents text nobody printed. */
export function toDisplayLines(text: string): string[] {
  if (text === "") return []
  const out: string[] = []
  for (const line of text.split("\n")) {
    if (line.includes("\r")) {
      const segments = line.split("\r")
      out.push(segments[segments.length - 1] ?? "")
      continue
    }
    out.push(line)
  }
  return out
}

/** Abbreviate one line to `headCols` + `…` + `tailCols`, grapheme- and
 *  cell-aware: a wide CJK or emoji line is measured in terminal cells, not in
 *  code units, so the abbreviation cannot land mid-glyph. */
export function truncateMiddle(line: string, headCols = LINE_HEAD_COLS, tailCols = LINE_TAIL_COLS): string {
  const head = Math.max(0, Math.trunc(headCols))
  const tail = Math.max(0, Math.trunc(tailCols))
  if (stringWidth(line) <= head + tail + 1) return line
  const cells = graphemes(line)
  const keep: string[] = []
  let used = 0
  for (const cell of cells) {
    const w = Math.max(1, stringWidth(cell))
    if (used + w > head) break
    keep.push(cell)
    used += w
  }
  const reversed: string[] = []
  let tailUsed = 0
  for (let i = cells.length - 1; i >= 0; i--) {
    const cell = cells[i]
    const w = Math.max(1, stringWidth(cell))
    if (tailUsed + w > tail) break
    reversed.push(cell)
    tailUsed += w
  }
  reversed.reverse()
  return `${keep.join("")}…${reversed.join("")}`
}

/**
 * Head-and-tail preview of `text`.
 *
 * When the line count fits the budget nothing is dropped, so short output — the
 * common case — renders whole and byte-identical to what the caller had before.
 */
export function previewOutput(text: string, options: OutputPreviewOptions = {}): OutputPreview {
  const headLines = Math.max(0, Math.trunc(options.headLines ?? PREVIEW_HEAD_LINES))
  const tailLines = Math.max(0, Math.trunc(options.tailLines ?? PREVIEW_TAIL_LINES))
  const headCols = options.headCols ?? LINE_HEAD_COLS
  const tailCols = options.tailCols ?? LINE_TAIL_COLS
  const all = toDisplayLines(text)
  const partial = text !== "" && !text.endsWith("\n")
  const budget = headLines + tailLines
  if (all.length <= budget) {
    return { lines: all.map((line) => truncateMiddle(line, headCols, tailCols)), hidden: 0, partial }
  }
  const head = all.slice(0, headLines)
  const tail = all.slice(all.length - tailLines)
  return {
    lines: [...head, ...tail].map((line) => truncateMiddle(line, headCols, tailCols)),
    hidden: all.length - head.length - tail.length,
    partial,
  }
}

/** One-line "… 42 lines hidden …" marker; empty when nothing is hidden.
 *  `expandable` names the way out while Ctrl+O still has more to give; past
 *  the unfold cap the marker stops promising a key that would do nothing. */
export function hiddenLinesLabel(hidden: number, expandable = true): string {
  if (hidden <= 0) return ""
  if (!expandable) return `… ${hidden} lines hidden …`
  return `… ${hidden} lines hidden · Ctrl+O to expand …`
}
