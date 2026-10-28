/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Animation primitives for the Ink TUI.
 *
 * Everything here is a PURE function of (tick, inputs) — no timers, no React,
 * no terminal I/O. That is deliberate: the renderer drives one shared clock
 * (see frame-clock.ts) and every widget derives its look from the same tick, so
 * N live tool boxes animate in lockstep off a single timer instead of each
 * running its own `setInterval` and forcing its own partial redraw.
 *
 * Two invariants every function here upholds, because breaking either was the
 * historical source of TUI jank:
 *  - WIDTH STABILITY: every generator returns exactly the requested cell count.
 *    A frame that changes width reflows the whole line, and a 60 Hz width
 *    flicker reads as tearing, not as motion.
 *  - GRAPHEME SAFETY: text is walked with {@link graphemes} and measured with
 *    {@link stringWidth}, never with `String.length`, so CJK, emoji and
 *    combining marks occupy the cells the terminal actually gives them.
 */

import { graphemes, stringWidth } from "./utils/stringWidth.js"
import { mixRgb, parseHex, rgbToHex } from "./themeColors.js"

/* ─── easing ─── */

export type EasingName =
  | "linear"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeOutExpo"
  | "easeOutBack"
  | "easeOutElastic"
  | "easeInOutSine"

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Non-finite input collapses to the END of the range it overshot rather than
 *  poisoning downstream maths: elapsed time past the window is "done" (+∞ → 1),
 *  a missing number is "not started" (NaN → 0). */
function safe01(v: number): number {
  return Number.isNaN(v) ? 0 : clamp01(v)
}

const EASING: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  // Terminal motion is discrete: at 12 fps the last 200ms of a true expo curve
  // is a single frame, so expo is clamped to stay monotone over few frames.
  easeOutExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  easeOutBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  easeOutElastic: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
}

export function ease(name: EasingName, t: number): number {
  // easeOutBack/Elastic intentionally overshoot past 1; clamping them here is
  // what turns a "pop" into a flat hold, so only the INPUT is sanitised.
  return EASING[name](safe01(t))
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/** 0..1 over `durationMs` of elapsed time, eased. Duration <= 0 snaps to done. */
export function progressAt(elapsedMs: number, durationMs: number, name: EasingName = "easeOutCubic"): number {
  if (!(durationMs > 0)) return 1
  return ease(name, safe01(elapsedMs / durationMs))
}

export function cycleIndex(tick: number, length: number): number {
  if (!(length > 0)) return 0
  const t = Number.isFinite(tick) ? Math.trunc(tick) : 0
  return ((t % length) + length) % length
}

/* ─── spinner presets ─── */

export type SpinnerPresetName =
  | "braille"
  | "line"
  | "arc"
  | "circle"
  | "arrow"
  | "moon"
  | "grow"
  | "bounce"
  | "meter"
  | "hourglass"
  | "orbit"
  | "square"

/** Frame sets per spinner style — see {@link spinnerPreset} for the contract. */
const PRESETS: Record<SpinnerPresetName, { unicode: string[]; ascii: string[] }> = {
  braille: { unicode: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], ascii: ["|", "/", "-", "\\"] },
  line: { unicode: ["─", "╲", "│", "╱"], ascii: ["-", "\\", "|", "/"] },
  arc: { unicode: ["◜", "◠", "◝", "◞", "◡", "◟"], ascii: ["(", "_", ")", "_"] },
  circle: { unicode: ["◡", "●"], ascii: ["_", "o"] },
  arrow: { unicode: ["←", "↖", "↑", "↗", "→", "↘", "↓", "↙"], ascii: ["<", "^", ">", "^", "<", "v", ">", "v"] },
  moon: { unicode: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"], ascii: ["@", "%", "#", "*", "#", "%", "@", "*"] },
  grow: { unicode: ["·", "·", "•", "●", "◉", "●", "•", "·"], ascii: [".", ".", "o", "O", "0", "O", "o", "."] },
  bounce: { unicode: ["▘", "▝", "▗", "▖"], ascii: ["L", "7", "7", "L"] },
  meter: {
    unicode: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂", "▁"],
    ascii: [",", ":", "|", ":", ","],
  },
  hourglass: { unicode: ["⏳", "⏳", "⌛", "⌛"], ascii: ["|", "/", "-", "\\"] },
  orbit: {
    unicode: ["·◦", "°◦", "◑◦", "◧◦", "◰◦", "◳◦", "◲◦", "◱◦"],
    ascii: [".'", "o'", "@'", "#'", "O'", "@'", "o'", ".'"],
  },
  square: { unicode: ["◰", "◳", "◲", "◱"], ascii: ["[", "]", "[", "]"] },
}

/**
 * The frame set for a spinner style, in the active glyph coverage.
 *
 * Every preset carries an ASCII set because `NEMO_GLYPHS=ascii` is used on
 * terminals with no braille coverage (and by CI captures), where a preset that
 * only shipped Unicode would render as blank cells — no motion at all. Unknown
 * names fall back to braille, which is what `spinnerFrames()` historically did.
 *
 * All frames within one preset are the same display width, which is the
 * property that keeps a label from shifting under the spinner as it ticks.
 */
export function spinnerPreset(name: SpinnerPresetName | string, ascii = false): string[] {
  // `hasOwnProperty`, not `??`: PRESETS is a plain object literal, so
  // PRESETS["__proto__"] hands back Object.prototype — truthy, with no frame
  // array on it. One poisoned NEMO_SPINNER value would then throw inside
  // every widget that reads its frames.
  const preset = isSpinnerPresetName(name) ? PRESETS[name] : PRESETS.braille
  // A copy: callers hand the array to widgets that index and slice it, and a
  // shared mutable table would let one `.sort()` change every spinner.
  return (ascii ? preset.ascii : preset.unicode).slice()
}

/** Whether `name` spells one of the built-in styles (and is not a stray object key). */
export function isSpinnerPresetName(name: string): name is SpinnerPresetName {
  return Object.prototype.hasOwnProperty.call(PRESETS, name)
}

/** Every style by name, in declaration order — what `/spinner` lists and validates against. */
export function spinnerPresetNames(): SpinnerPresetName[] {
  return Object.keys(PRESETS) as SpinnerPresetName[]
}

/* ─── progress bars ─── */

export type BarStyle = "block" | "shade" | "braille" | "bullet" | "arrow" | "ascii"

interface BarGlyphs {
  full: string
  parts: string[]
  empty: string
  head: string
}

const BARS: Record<BarStyle, BarGlyphs> = {
  // `parts` is the sub-cell ramp: index i of a remainder r shows r ≈ (i+1)/n of
  // a cell. A style with no honest fractional glyph uses `[]` and the code falls
  // back to the full glyph — never an empty string, which would punch a hole in
  // the bar and break the exact-width contract.
  block: { full: "█", parts: ["▏", "▎", "▍", "▌", "▋", "▊", "▉"], empty: "░", head: "▏" },
  shade: { full: "▓", parts: [], empty: "░", head: "▐" },
  braille: { full: "⣿", parts: ["⡀", "⣄", "⣤", "⣦", "⣶", "⣷"], empty: "⣀", head: "⣿" },
  bullet: { full: "●", parts: [], empty: "○", head: "◉" },
  arrow: { full: "▐", parts: [], empty: "▕", head: "▶" },
  ascii: { full: "#", parts: ["-", "=", "+"], empty: ".", head: ">" },
}

export interface ProgressBarOptions {
  /** Draw the leading head glyph one cell inside the fill (default true). */
  head?: boolean
  /** Style override when the terminal has no Unicode coverage. */
  ascii?: boolean
}

/** Which side of the boundary a bar cell is on, for per-cell colouring. */
export type BarZone = "filled" | "partial" | "empty"

export interface BarCell {
  glyph: string
  zone: BarZone
}

/**
 * The cell-by-cell form of a determinate bar — exactly `width` entries, each
 * carrying which zone it belongs to.
 *
 * This exists because the useful on-screen bar colours the fill in the accent
 * and the track in the border tone, which needs two `<Text>` runs — and a plain
 * string would throw the boundary away. Sub-cell precision is carried by the
 * fractional glyph (`parts`), so a 40-cell bar still moves smoothly for a job
 * that reports 0.1% increments; snapping to whole cells makes short bars look
 * frozen, which is what users report as "progress nahi dikh raha".
 */
export function progressCells(
  frac: number,
  width: number,
  style: BarStyle = "block",
  opts: ProgressBarOptions = {},
): BarCell[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0
  if (w === 0) return []
  const glyphs = BARS[opts.ascii ? "ascii" : style] ?? BARS.block
  const f = safe01(frac)
  const exact = f * w
  const filled = Math.floor(exact)
  const remainder = exact - filled
  const parts = glyphs.parts.length > 0 ? glyphs.parts : [glyphs.full]
  const partialIndex = Math.min(parts.length - 1, Math.floor(remainder * parts.length))
  const usePartial = filled < w && remainder > 0

  const cells: BarCell[] = []
  for (let i = 0; i < filled; i++) cells.push({ glyph: glyphs.full, zone: "filled" })
  if (usePartial) cells.push({ glyph: parts[partialIndex], zone: "partial" })
  while (cells.length < w) cells.push({ glyph: glyphs.empty, zone: "empty" })
  if (opts.head !== false && f > 0 && f < 1 && !usePartial && filled > 0) {
    // The head marks the leading edge. When the edge cell is already a
    // fractional glyph it IS the head — overwriting it with a fixed tip glyph
    // (which is what this used to do) threw away the sub-cell precision the
    // partial cell exists to carry.
    cells[filled - 1] = { glyph: glyphs.head, zone: "filled" }
  }
  return cells
}

/**
 * The cell form of a sweeping bar — same zones as a determinate bar, so
 * one colouring path drives both.
 *
 * The window bounces rather than wrapping: a bar that jumps back to column 0
 * reads as the job restarting, which is the opposite of what is happening.
 */
export function indeterminateCells(
  width: number,
  tick: number,
  windowCells = 4,
  style: BarStyle = "block",
  ascii = false,
): BarCell[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0
  if (w === 0) return []
  const glyphs = BARS[ascii ? "ascii" : style] ?? BARS.block
  const win = Math.max(1, Math.min(windowCells, w))
  // Triangle wave period: one round trip over (w - win + 1) * 2 steps.
  const span = Math.max(1, w - win + 1)
  const phase = cycleIndex(tick, span * 2)
  const start = phase < span ? phase : span * 2 - phase - 1
  const cells: BarCell[] = []
  for (let i = 0; i < w; i++) {
    const inside = i >= start && i < start + win
    cells.push({ glyph: inside ? glyphs.full : glyphs.empty, zone: inside ? "filled" : "empty" })
  }
  return cells
}

/* ─── shimmer / marquee ─── */

export interface ShimmerOptions {
  /** Traveling band width in cells (default 4). */
  width?: number
  /** Cells between repeats of the band (default: length + band, so the glow
   *  fully exits before re-entering instead of wrapping mid-band). */
  stride?: number
  /** Smooth (sine) or hard-edged (0/1) band. Default smooth. */
  hard?: boolean
}

/**
 * Per-cell intensity in 0..1 for a highlight sweeping across `length` cells.
 *
 * Returns one entry per grapheme, always. Callers map intensity to colour mix
 * or bold/dim, so the same generator drives a text shimmer and a border chase.
 */
export function shimmerIntensities(length: number, tick: number, opts: ShimmerOptions = {}): number[] {
  const n = Number.isFinite(length) ? Math.max(0, Math.trunc(length)) : 0
  if (n === 0) return []
  const band = Math.max(1, Math.trunc(opts.width ?? 4))
  const stride = Math.max(band, Math.trunc(opts.stride ?? n + band))
  const head = cycleIndex(tick, stride)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    // Distance along the ring, so the band wraps cleanly at the tail.
    const d = (((i - head) % stride) + stride) % stride
    const inside = d < band ? 1 - d / band : 0
    out.push(opts.hard ? (inside > 0 ? 1 : 0) : inside)
  }
  return out
}

export interface MarqueeOptions {
  /** Pause at each end, in ticks (default 4 — an instant turnaround is unreadable). */
  hold?: number
  /** Gap cells between repeats when the text is shorter than the viewport. */
  gap?: number
  ascii?: boolean
}

/**
 * Scroll `text` through a viewport of exactly `width` cells.
 *
 * Text that fits is never scrolled — it is padded to width and held. Scrolling
 * a short label for no reason is the single most annoying terminal marquee
 * behaviour, and it is what the naive version did.
 */
export function marquee(text: string, width: number, tick: number, opts: MarqueeOptions = {}): string {
  const w = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0
  if (w === 0) return ""
  if (text === "") return " ".repeat(w)
  const cells = graphemes(text)
  const total = stringWidth(text)
  const gap = Math.max(1, Math.trunc(opts.gap ?? 3))
  if (total <= w) return padRight(cells, w)
  const scrollLength = total + gap
  const hold = Math.max(0, Math.trunc(opts.hold ?? 4))
  // Ticks are frame counts; convert the hold into a scroll offset by freezing
  // the offset at the ends rather than special-casing the position maths.
  const cycleTicks = scrollLength + hold * 2
  const step = cycleIndex(tick, cycleTicks)
  const offset = Math.max(0, Math.min(scrollLength - 1, step - hold))
  const ring = [...cells, ...graphemes(" ".repeat(gap))]
  const out: string[] = []
  let used = 0
  let i = offset
  while (used < w && out.length < ring.length * 2) {
    const cell = ring[i % ring.length]
    const cw = Math.max(1, stringWidth(cell))
    if (used + cw > w) break
    out.push(cell)
    used += cw
    i++
  }
  return padRight(out, w)
}

function padRight(cells: string[], w: number): string {
  let s = cells.join("")
  const pad = w - stringWidth(s)
  if (pad > 0) s += " ".repeat(pad)
  else if (pad < 0) s = trimToWidth(s, w)
  return s
}

function trimToWidth(s: string, w: number): string {
  let out = ""
  let used = 0
  for (const cell of graphemes(s)) {
    const cw = Math.max(1, stringWidth(cell))
    if (used + cw > w) break
    out += cell
    used += cw
  }
  return out
}

/** Cycling "… …." indicator — 4 phases, width 0..3 so callers pad deliberately. */
export function waitingDots(tick: number, phases = 4): string {
  const dot = "."
  return dot.repeat(cycleIndex(tick, phases))
}

/** Reveal `text` up to `charsShown` graphemes (streaming typewriter). */
export function reveal(text: string, charsShown: number): string {
  const n = Number.isFinite(charsShown) ? Math.max(0, Math.trunc(charsShown)) : 0
  const cells = graphemes(text)
  return cells.slice(0, n).join("")
}

/* ─── colour animation ─── */

/**
 * Interpolate along a list of `#rrggbb` stops.
 *
 * Malformed stops are dropped rather than thrown on; if fewer than two survive
 * the function returns the single usable stop (or the fallback) so a theme with
 * one accent still renders, it just does not ramp.
 */
export function colorRamp(stops: string[], t: number, fallback = "#808080"): string {
  const valid = stops.filter((s) => parseHex(s) !== undefined)
  if (valid.length === 0) return fallback
  if (valid.length === 1) return valid[0]
  const f = safe01(t) * (valid.length - 1)
  const i = Math.min(valid.length - 2, Math.floor(f))
  const from = parseHex(valid[i])
  const to = parseHex(valid[i + 1])
  if (!from || !to) return valid[i]
  return rgbToHex(mixRgb(from, to, f - i))
}

/** Palette index advancing with the tick — the colour half of a chase. */
export function paletteAt(palette: string[], tick: number, fallback = ""): string {
  if (palette.length === 0) return fallback
  return palette[cycleIndex(tick, palette.length)]
}

/**
 * A ramp of `count` colours spanning `cycles` full laps of the palette, for a
 * per-cell rainbow (progress head, thinking ribbon). Ends meet: cell `count`
 * would repeat cell 0, so the ramp is closed-loop.
 */
export function colorCycle(palette: string[], count: number, cycles = 1, fallback = "#808080"): string[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
  if (n === 0) return []
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(colorRamp(palette, ((i / n) * cycles) % 1, fallback))
  return out
}

/* ─── motion policy ─── */

/** Off = no timer at all (final frame only), Reduced = slow + no sweeps,
 *  Full = everything. A CI capture or an SSH-over-mobile session wants `off`. */
export type MotionLevel = "off" | "reduced" | "full"

const TRUTHY = new Set(["1", "true", "yes", "on"])
const FALSY = new Set(["0", "false", "no", "off"])

/**
 * What a level does, in the user's words.
 *
 * This is the text `/motion` reports, kept next to the policy it describes so the
 * command cannot promise something the resolver does not do. "Reduced" is not
 * self-explanatory, and the gap between it and "off" is the entire point: one
 * still paints movement-free colour, the other installs no timer at all.
 */
export function describeMotionLevel(level: MotionLevel): string {
  switch (level) {
    case "off":
      return "no animation timers at all — every widget paints its finished frame"
    case "reduced":
      return "colour still breathes, but nothing sweeps, chases or travels"
    case "full":
      return "spinners, sweeps and shimmers at their own pace"
  }
}

/**
 * Spell a motion level, or nothing when the text is not one.
 *
 * Shared by the env resolver below and by `/motion <level>`, so the flag, the
 * environment and the command cannot drift into accepting different spellings of
 * one preference. A falsy value means "no motion" rather than "fall through to
 * the default" — `0` and `off` must agree.
 */
export function parseMotionLevel(raw: string): MotionLevel | undefined {
  const v = raw.trim().toLowerCase()
  if (FALSY.has(v) || v === "off" || v === "none" || v === "static") return "off"
  if (TRUTHY.has(v) || v === "full" || v === "all" || v === "max") return "full"
  if (v === "reduce" || v === "reduced" || v === "low") return "reduced"
  return undefined
}

/**
 * Resolve the motion level from a flag, an environment snapshot and a stored preference.
 *
 * Pure and injected on purpose: the process.env read belongs to the boot
 * resolver, not here (lint rule `no-direct-process-env`, and a component that
 * reads env itself cannot be tested against the reduced-motion path).
 *
 * Precedence: explicit flag > NEMO_MOTION > NEMO_REDUCED_MOTION > stored > full.
 *
 * `stored` is the level the user last left `/motion` on, and it sits BELOW the
 * environment for a reason: a saved preference says "how I like this machine",
 * an env var says "how I want THIS run". Somebody who exports
 * `NEMO_MOTION=off` to record a clean capture must not have their desktop
 * setting reopen the animation, and the same person must not have to remember
 * to unset it afterwards.
 */
export function resolveMotion(input: {
  flag?: string | boolean | undefined
  env?: Record<string, string | undefined>
  stored?: string | undefined
}): MotionLevel {
  const flag = input.flag
  if (typeof flag === "boolean") return flag ? "full" : "off"
  if (typeof flag === "string") {
    const parsed = parseMotionLevel(flag)
    if (parsed) return parsed
  }

  const motion = (input.env?.NEMO_MOTION ?? "").trim()
  if (motion) {
    const parsed = parseMotionLevel(motion)
    if (parsed) return parsed
  }

  const reduced = (input.env?.NEMO_REDUCED_MOTION ?? "").trim()
  if (reduced && TRUTHY.has(reduced.toLowerCase())) return "reduced"

  // An unreadable stored value falls through to "full" rather than resolving to
  // a level the user never asked for — but it is still only consulted last, so
  // the env checks above already had their chance.
  const stored = parseMotionLevel(input.stored ?? "")
  if (stored) return stored
  return "full"
}

/** Frame interval a widget should tick at for this motion level.
 *  `off` returns 0, which callers treat as "do not subscribe". */
export function motionIntervalMs(ms: number, level: MotionLevel): number {
  if (level === "off") return 0
  if (level === "reduced") return Math.max(500, Math.round(ms * 4))
  return ms
}

/** Whether a moving part (sweep, chase, marquee) is allowed at all.
 *  Reduced keeps the colour changes but stops things travelling, which is the
 *  part that triggers motion sensitivity. */
export function motionTravels(level: MotionLevel): boolean {
  return level === "full"
}
