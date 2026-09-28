/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { stringWidth, sliceByWidth } from "./utils/stringWidth.js"
import { g } from "./glyphs.js"

/**
 * Pure width-fitting for the status-bar Footer ("cmd size ke hisab se
 * sab adjust" — every footer line must fit the terminal, no mid-word
 * wraps, no second line).
 *
 * Column budget (Footer renders INSIDE the fullscreen frame, now WITH
 *  its own rounded section border — "ye section bhi rounded": the nest
 *  line is the requested look, not an accident):
 *   App root Box      borderStyle="round"  → 2 cols (1 left + 1 right)
 *   Footer box border borderStyle="round"  → 2 cols (left + right; top open)
 *   Footer Box        paddingX={1}         → 2 cols
 *   ─────────────────────────────────────────────
 *   FRAME_OVERHEAD                       = 6 cols
 *
 * inner = columns - 6 is what the content row may occupy.
 *
 * Sacrifice order (what survives at each width):
 *   1. core status segments (dot+status, Mode, Tokens) — always attempted
 *   2. optionals by display priority: bg count, queue count, ctx %,
 *      bg spinner, bg hint, subagent chips, task hint — added only while
 *      they fit, keeping a floor of MIN_MODEL columns for the model name
 *   3. model name — truncated with "…" only after optionals claimed space
 *   4. key hints — the longest variant (full → medium → short) that still
 *      fits in the slack left after the model; dropped entirely otherwise
 *
 * `fits=false` only on absurdly narrow terminals (core alone overflows);
 * the Footer pairs this with wrap="truncate" as a rendering safety net so
 * a miscount can never split a word across lines again.
 */

export interface FooterSegment {
  /** Stable identity: "status" | "mode" | "tokens" | "bg" | "queue" |
   *  "ctx" | "spinner" | "bg-hint" | "task-hint" | "hints" | "chip:<index>". */
  id: string
  /** Exact displayed text — its length IS the width budget (chip icons are
   *  a 1-col placeholder char + space + label; the Footer swaps the char
   *  for a Spinner/colored icon of the same width when rendering). */
  text: string
}

export interface FooterFitInput {
  /** Terminal columns (stdout.columns read at render time). */
  columns: number
  model: string
  statusText: string
  modeText: string
  tokenText: string
  /** Context-window usage, e.g. "ctx 42%" — first optional to go when tight. */
  ctxText?: string
  bgText?: string
  queueText?: string
  /** bg subagent running — a 1-column spinner segment. */
  spinner?: boolean
  bgHint?: string
  taskHint?: string
  /** Chip display texts, already formatted as `<icon> <label>`. */
  subagentLabels?: string[]
  /** Key-hint strings, longest → shortest; the first that fits wins.
   *  Pass `[]` to disable hints entirely. */
  hintVariants?: string[]
}

export interface FooterFit {
  /** Usable content columns: max(columns - FRAME_OVERHEAD, 10). */
  inner: number
  /** Model name, possibly truncated with a trailing "…". */
  model: string
  /** Right-side segments in display order (separator gaps NOT included). */
  segments: FooterSegment[]
  /** model gap + segment widths + gaps — what actually renders. */
  width: number
  /** True when everything rendered is guaranteed ≤ inner columns. */
  fits: boolean
}

/** App border (2) + Footer paddingX (2). Footer is borderless (frame owns it). */
export const FRAME_OVERHEAD = 6
/** Columns between the model and the right block, and between segments. */
export const SEGMENT_GAP = 2
/** Model name keeps at least this many columns while optionals compete. */
const MIN_MODEL = 12

/** Cut `s` to at most `max` COLUMNS, appending "…" when cut. Width-aware:
 * the old s.length/slice math split 2-cell glyphs (CJK/emoji) in half and
 * counted them as 1, so exact-fit footers wrapped. */
export const truncateTo = (s: string, max: number): string => {
  if (max <= 0) return ""
  if (stringWidth(s) <= max) return s
  if (max === 1) return "…"
  // Grapheme-boundary cut: a per-code-point loop could strand a combining
  // mark (Devanagari matra) at the clip without its base glyph.
  return sliceByWidth(s, max - 1) + "…"
}

const segmentsWidth = (segments: FooterSegment[]): number =>
  segments.reduce((sum, seg, i) => sum + stringWidth(seg.text) + (i > 0 ? SEGMENT_GAP : 0), 0)

/** Total rendered width: model (+gap) + segments (+gaps). */
const totalWidth = (model: string, segments: FooterSegment[]): number =>
  (model.length > 0 ? stringWidth(model) + SEGMENT_GAP : 0) + segmentsWidth(segments)

export const fitFooter = (input: FooterFitInput): FooterFit => {
  const inner = Math.max(input.columns - FRAME_OVERHEAD, 10)

  // Core: always rendered — the operational readout the user checks first.
  const segments: FooterSegment[] = [
    { id: "status", text: `${g("dot")} ${input.statusText}` },
    { id: "mode", text: input.modeText },
    { id: "tokens", text: input.tokenText },
  ]

  // Optionals in display order; each is added only while the row stays
  // within budget, reserving a floor for the model name.
  const modelReserve = Math.min(MIN_MODEL, stringWidth(input.model))
  const budget = Math.max(0, inner - modelReserve - SEGMENT_GAP)

  const optionals: FooterSegment[] = []
  if (input.bgText) optionals.push({ id: "bg", text: input.bgText })
  if (input.queueText) optionals.push({ id: "queue", text: input.queueText })
  if (input.ctxText) optionals.push({ id: "ctx", text: input.ctxText })
  if (input.spinner) optionals.push({ id: "spinner", text: g("spinnerDot") })
  if (input.bgHint) optionals.push({ id: "bg-hint", text: input.bgHint })
  ;(input.subagentLabels ?? []).forEach((label, i) => optionals.push({ id: `chip:${i}`, text: label }))
  if (input.taskHint) optionals.push({ id: "task-hint", text: input.taskHint })

  for (const opt of optionals) {
    const candidate = [...segments, opt]
    if (segmentsWidth(candidate) <= budget) {
      segments.push(opt)
    }
  }

  // Model: gets everything left after the right block. When optionals ate
  // the slack this truncates (with "…"), never wraps.
  const modelBudget = inner - segmentsWidth(segments) - SEGMENT_GAP
  const model = truncateTo(input.model, modelBudget)

  // Hints: longest variant that fits the slack AFTER the model — hints
  // never push the model into truncation (priority: core > optionals >
  // model > hints).
  const variants = input.hintVariants ?? []
  const slack = inner - totalWidth(model, segments) - SEGMENT_GAP
  const hint = variants.find((v) => v.length > 0 && stringWidth(v) <= slack)
  if (hint !== undefined) {
    segments.push({ id: "hints", text: hint })
  }

  const width = totalWidth(model, segments)
  return { inner, model, segments, width, fits: width <= inner }
}
