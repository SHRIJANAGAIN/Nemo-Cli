/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Silver dotted sphere — the pure core of the thinking indicator.
 *
 * The visible piece is `<ThinkingOrbs>` (the full sphere) plus the footer's
 * one-row orbit chase; everything here is Ink-free so the maths unit-tests
 * without a renderer.
 *
 * THE SPHERE (unicode): a dot-grid ball drawn with braille cells (each cell
 * is 2×4 dots, always exactly one column wide, so the grid can never tear
 * into stairs). Dots light by depth × a sweeping meridian wave, which reads
 * as the globe turning; a diagonal white glint sweeps periodically — that is
 * the shine. Silhouette comes free from the depth gate (limb dots never
 * light).
 *
 * THE ORBIT (footer, one row only — a sphere needs height the footer does
 * not have): six dots chase around a small ellipse, with one travelling
 * white dot. Same silver family, same tick, so it reads as the sphere's
 * little sibling rather than a second design.
 *
 * Colour is a fixed SILVER ramp, not theme-derived: it sits on every turn on
 * light and dark themes alike.
 */

/** Milliseconds per animation tick driving sphere and orbit. */
export const RIBBON_TICK_MS = 90

/**
 * Silver ramp, dimmest → brightest. The last entry is the glint (pure white).
 */
export const SILVER_RAMP: readonly string[] = ["#3f3f3f", "#7a7a7a", "#b8b8b8", "#e8e8e8", "#ffffff"]

/** Brightest non-glint step — the wave's peak. */
export const SILVER_HOT = SILVER_RAMP.length - 2
/** The glint step. Only reachable during a glint sweep. */
export const SILVER_GLINT = SILVER_RAMP.length - 1

/** Clamp any integer into a ramp index. Exported for tests. */
export function silverShade(level: number): string {
  const max = SILVER_RAMP.length - 1
  const k = Math.min(max, Math.max(0, Math.round(level)))
  return SILVER_RAMP[k] as string
}

/** Braille blank: zero dots, still exactly one column wide, so empty cells
 *  hold the grid together instead of collapsing it. */
export const BRAILLE_BLANK = "⠀"

/** Braille bit for a dot at (dx, dy) inside its cell. */
function brailleBit(dx: number, dy: number): number {
  const col0 = [0, 1, 2, 6]
  const col1 = [3, 4, 5, 7]
  const bits = dx === 0 ? col0 : col1
  return 1 << (bits[Math.min(3, Math.max(0, dy))] as number)
}

/** Blue ramp for the thinking square (same steps as silver, blue family). */
export const BLUE_RAMP: readonly string[] = ["#14305c", "#2563eb", "#60a5fa", "#dbeafe", "#ffffff"]

/** Brightest blue step — the travelling head. */
export const BLUE_HOT = BLUE_RAMP.length - 1

/* ── Thinking grid: 3×3 blue dots, brightness travelling ─────────────── */

/**
 * Nine blue dots in a 3×3 grid beside the shimmer word. A brightness wave
 * sweeps diagonally across (dim → bright → white-hot head → dim): all nine
 * dots stay lit, only the light moves. Single-cell ● glyphs, so no font can
 * reshape it.
 */
export const GRID_COLS = 3
export const GRID_ROWS = 3

/** Wandering track: round the square, dip through the middle, out straight
 *  left, back along the rim — up, down and all ways, never one monotonous
 *  loop. One tick per step keeps it spinning fast (~1.1s a tour). */
const TRACK: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [2, 0],
  [2, 1],
  [1, 1],
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 2],
  [2, 1],
  [1, 1],
  [1, 0],
]

/** Brightness level 0..4 for grid dot (x, y) at `frame`. Pure. */
export function gridLevel(x: number, y: number, frame: number): number {
  const head = (((Math.floor(frame) % TRACK.length) + TRACK.length) % TRACK.length)
  // Nearest path visit wins: cells the track crosses twice (middle, edges)
  // light on the closest pass, so the trail never doubles up on one cell.
  let behind = -1
  for (let i = 0; i < TRACK.length; i++) {
    const cell = TRACK[i] as readonly [number, number]
    if (cell[0] !== x || cell[1] !== y) continue
    const d = (i - head + TRACK.length) % TRACK.length
    if (behind < 0 || d < behind) behind = d
  }
  if (behind < 0) return 0
  // The three eyes ride together: head + two trailers behind the motion.
  // Everything else is dark — active then deactive as the group travels.
  if (behind === 0) return BLUE_HOT
  if (behind <= 2) return 3
  return 0
}

export interface GridCell {
  readonly glyph: string
  readonly color: string
}

/** Full 3×3 grid for one frame. Only the three travelling eyes light (small
 *  '·', latin-1, renders everywhere); the rest is empty space, so the group
 *  visibly moves round the square — active then deactive. */
export function gridPaint(frame: number, ascii = false): GridCell[][] {
  void ascii
  const f = Math.floor(frame)
  const rows: GridCell[][] = []
  for (let y = 0; y < GRID_ROWS; y++) {
    const row: GridCell[] = []
    for (let x = 0; x < GRID_COLS; x++) {
      const level = gridLevel(x, y, f)
      if (level <= 0) {
        row.push({ glyph: " ", color: BLUE_RAMP[0] as string })
        continue
      }
      row.push({
        glyph: "·",
        color: (BLUE_RAMP[level] ?? BLUE_RAMP[BLUE_HOT]) as string,
      })
    }
    rows.push(row)
  }
  return rows
}

/**
 * The same 3×3 at rest: nine dots, all at the trail shade, none hot.
 *
 * This is what `reduced` and `off` show. It is not `gridPaint(0)`, and the
 * difference is the whole point of a resting frame: frame 0 is one corner of a
 * travelling group with six cells of empty space — a *moment*, which reads as a
 * half-drawn indicator. Asking for no movement is not asking for an indicator
 * that looks broken, so the still gets designed rather than sampled. Same three
 * cells a row, so the width contract holds either way.
 */
export function gridSettled(): GridCell[][] {
  return Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => ({ glyph: "·", color: BLUE_RAMP[3] as string })),
  )
}

/* ── Footer square: the old 6-dot braille cluster ────────────────────── */

/** Footer square width in cells. Two cells of dense braille read as a small
 *  square cluster (~6 visible dots) — the look the footer had and kept. */
export const ORBIT_CELLS = 2

/** Dots packed into the square. Twelve across 2 cells merge dense; about six
 *  read bright at a time while the comet head travels. */
const ORBIT_DOTS = 12

/** Chase speed (radians per tick). */
const ORBIT_OMEGA = 0.6

export interface OrbitCell {
  readonly glyph: string
  readonly color: string
}

/** The k-th of the twelve dots on the ellipse: its cell dot, plus the angle
 *  the comet head is measured against. */
function orbitDot(k: number): { px: number; py: number; ang: number } {
  const ang = (2 * Math.PI * k) / ORBIT_DOTS
  return {
    px: Math.min(3, Math.max(0, Math.round(1.5 + 1.5 * Math.cos(ang)))),
    py: Math.min(3, Math.max(0, Math.round(1.5 + 1.5 * Math.sin(ang)))),
    ang,
  }
}

/** Merge the lit dots into the two braille cells, each cell taking its
 *  brightest dot. Shared by the animated and the resting paint. */
function packOrbit(lit: ReadonlyArray<{ px: number; py: number; level: number }>, ascii: boolean): OrbitCell[] {
  const cells: Array<{ bits: number; level: number }> = [
    { bits: 0, level: 0 },
    { bits: 0, level: 0 },
  ]
  for (const dot of lit) {
    const cell = cells[Math.min(ORBIT_CELLS - 1, dot.px >> 1)] as { bits: number; level: number }
    cell.bits |= brailleBit(dot.px % 2, dot.py)
    if (dot.level > cell.level) cell.level = dot.level
  }
  return cells.map((cell) => {
    if (cell.bits === 0) {
      return { glyph: ascii ? " " : BRAILLE_BLANK, color: SILVER_RAMP[0] as string }
    }
    return {
      glyph: ascii ? (cell.level >= SILVER_HOT ? "o" : ".") : String.fromCharCode(0x2800 + cell.bits),
      color: silverShade(cell.level),
    }
  })
}

/** Footer square for `frame`: the classic dense braille cluster with a comet
 *  head travelling round it and a cooling tail. Silver family, always. */
export function orbitPaint(frame: number, ascii = false): OrbitCell[] {
  const head = Math.floor(frame) * ORBIT_OMEGA
  return packOrbit(
    Array.from({ length: ORBIT_DOTS }, (_, k) => {
      const { px, py, ang } = orbitDot(k)
      // Angular distance behind the head, 0..1 (0 = the head itself). Floor
      // at 2: level 1 crushes to black on dark terminals and half the square
      // would vanish.
      const behind = ((((head - ang) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)
      const level = behind < 0.13 ? SILVER_GLINT : behind < 0.38 ? SILVER_HOT : 2
      return { px, py, level }
    }),
    ascii,
  )
}

/** The cluster at rest: every dot the same mid shade, so it reads as one dense
 *  square instead of a comet caught mid-pass. This is the frame `reduced` and
 *  `off` show — a still has to be DESIGNED, because any sampled frame of a
 *  travelling animation is by definition an lopsided one. */
export function orbitSettled(ascii = false): OrbitCell[] {
  return packOrbit(
    Array.from({ length: ORBIT_DOTS }, (_, k) => {
      const { px, py } = orbitDot(k)
      return { px, py, level: 2 }
    }),
    ascii,
  )
}

/** The square as one plain string — what the footer fit measures. */
export function orbitRowText(frame: number, ascii = false): string {
  return orbitPaint(frame, ascii)
    .map((c) => c.glyph)
    .join("")
}

/** Build codename line for the boot screen, e.g. "NV 1.2". */
export function bootCodename(version: string): string {
  const tag = /^\d+\.\d+\.\d+-(.+)$/.exec(version)?.[1]
  if (tag) return tag
  const release = /^v?(\d+)\.(\d+)\.\d+/.exec(version)
  return release ? `NV ${release[1]}.${release[2]}` : `v${version}`
}

/* ── Codex-style shimmer label (thinking indicator) ─────────────────── */

/**
 * Port of Codex's shimmer (codex-rs/tui/src/shimmer.rs + motion.rs) — design,
 * not files. A brightness band with cosine falloff sweeps across the LABEL
 * text itself (no separate glyph animation): chars near the band burn bright
 * and bold, the rest hold dim. The activity bullet rides just ahead of the
 * band. Sweep period is 2s like Codex; our 90ms tick divides it into ~22
 * steps per sweep.
 */
const SHIMMER_PAD = 10
/** Band half-width in chars (cosine falloff to zero at the edges). */
const SHIMMER_HALF_WIDTH = 5
/** Ticks per full sweep (2s at the 90ms ribbon tick). */
const SHIMMER_PERIOD_TICKS = 22

/** Shimmer intensity 0..1 for char `index` of a `length`-char label at `frame`. Pure. */
export function shimmerLevel(index: number, length: number, frame: number): number {
  if (length <= 0) return 0
  const period = length + SHIMMER_PAD * 2
  const pos = ((((Math.floor(frame) % SHIMMER_PERIOD_TICKS) + SHIMMER_PERIOD_TICKS) % SHIMMER_PERIOD_TICKS) / SHIMMER_PERIOD_TICKS) * period
  const dist = Math.abs(index + SHIMMER_PAD - pos)
  if (dist > SHIMMER_HALF_WIDTH) return 0
  return 0.5 * (1 + Math.cos((Math.PI * dist) / SHIMMER_HALF_WIDTH))
}

export interface ShimmerChar {
  readonly ch: string
  readonly color: string
  readonly bold: boolean
  readonly dim: boolean
}

/** Paint a label Codex-style: brightness band sweeping across, bold at the
 *  peak, dim outside. Grapheme-safe (never splits a mark or emoji). */
export function shimmerPaint(text: string, frame: number): ShimmerChar[] {
  const chars = [...text]
  return chars.map((ch, i) => {
    const t = shimmerLevel(i, chars.length, frame)
    if (t >= 0.66) {
      return { ch, color: SILVER_RAMP[SILVER_GLINT] as string, bold: true, dim: false }
    }
    if (t >= 0.33) {
      return { ch, color: silverShade(SILVER_HOT), bold: false, dim: false }
    }
    if (t > 0) {
      return { ch, color: silverShade(2), bold: false, dim: false }
    }
    return { ch, color: silverShade(1), bold: false, dim: true }
  })
}

/**
 * The label with no band on it: every char at the trail shade, none dimmed.
 *
 * `shimmerPaint(label, 0)` is NOT a resting frame — at frame 0 the band sits
 * ten cells off the left end of the word, so `shimmerLevel` returns 0 for every
 * char and the whole label renders DIMMED. That is the one piece of text on a
 * busy screen that has to be readable, and "turn the animation off" must not
 * cost the user the word "Thinking…". So the still gets designed, the same way
 * {@link gridSettled} does.
 */
export function shimmerSettled(text: string): ShimmerChar[] {
  return [...text].map((ch) => ({ ch, color: silverShade(SILVER_HOT), bold: false, dim: false }))
}

/** The activity bullet: brightness breathes on its own slower cycle, like
 *  Codex's pulsing • (their no-truecolor blink is •/◦ at 600ms). */
export function bulletLevel(frame: number): number {
  return Math.floor(frame / 7) % 2 === 0 ? SILVER_HOT : 1
}