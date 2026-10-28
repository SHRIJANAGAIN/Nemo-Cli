/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Central glyph table for the Ink TUI.
 *
 * All status glyphs in user-visible output MUST come from here via `g()`.
 * Unicode is the default everywhere (●○◌✓✗★❯█⚠ + braille spinners).
 * Opt out per terminal: NEMO_GLYPHS=ascii forces the ASCII set
 * (`* o - v x ! > _` + pipe spinner) for consoles whose fonts lack the
 * Unicode marks. NEMO_GLYPHS=unicode forces Unicode.
 * NEMO_SPINNER picks the spinner style (see spinnerPreset in animations.ts).
 */

import { spinnerPreset } from "./animations.js"

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
let cachedFrames: string[] | null = null
/** The style named by `/spinner` this session, or null to let the env speak. */
let spinnerOverride: string | null = null

/** Env passed as a parameter (the app-bootstrap convention) so the flag is
 * injectable in tests instead of hard-wired to the live process. */
export function glyphSet(env: NodeJS.ProcessEnv = process.env): GlyphSet {
  if (cached) return cached
  const mode = (env.NEMO_GLYPHS ?? "").trim().toLowerCase()
  if (mode === "ascii" || mode === "plain") return (cached = "ascii")
  return (cached = "unicode")
}

/** Test hook: clear the cached detection result and any live spinner switch. */
export function resetGlyphCache(): void {
  cached = null
  cachedFrames = null
  spinnerOverride = null
}

/** The glyph for `name` in the active set. Every glyph is width-1 in both sets. */
export function g(name: GlyphName): string {
  return (glyphSet() === "ascii" ? ASCII : UNICODE)[name]
}

/**
 * Spinner frames: the preset named by `/spinner`, else the one named by
 * NEMO_SPINNER (braille when neither speaks), in the ASCII set when the
 * glyph mode demands it — the pipe spinner is the historical behaviour on
 * `NEMO_GLYPHS=ascii`.
 *
 * Resolved once and cached, so the array identity a widget indexes never churns
 * between renders; a `/spinner` switch rebuilds it once, deliberately, and the
 * command's own reply re-renders the tree that sees it. Consumers index with
 * `cycleIndex(tick, frames.length)`, so styles with different frame counts are
 * interchangeable.
 */
export function spinnerFrames(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!cachedFrames) {
    const preset = spinnerOverride ?? (env.NEMO_SPINNER ?? "").trim().toLowerCase()
    cachedFrames = spinnerPreset(preset || "braille", glyphSet(env) === "ascii")
  }
  return cachedFrames
}

/** The style name now in force — the override if one was named, else the env, else `braille`. */
export function spinnerName(env: NodeJS.ProcessEnv = process.env): string {
  return spinnerOverride || (env.NEMO_SPINNER ?? "").trim().toLowerCase() || "braille"
}

/**
 * Switch the spinner style live.
 *
 * Returns the frames, so a caller can report what the widget will paint rather
 * than what it asked for; an unknown name falls back to braille exactly as the
 * env var does, which is what `/spinner` checks before saving anything.
 */
export function setSpinnerPreset(name: string): string[] {
  spinnerOverride = name.trim().toLowerCase()
  cachedFrames = null
  return spinnerFrames()
}
