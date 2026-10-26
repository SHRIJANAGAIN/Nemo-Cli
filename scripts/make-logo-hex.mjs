/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Draw the Nemo lockup PROCEDURALLY: the NEMO CLI wordmark in
 * silver, under a twinkling starfield.
 *
 * The hexagon ring and T monogram are gone on request — the wordmark alone
 * carries the brand, and the S1-TITANIUM identity lives in metal + stars
 * instead of geometry. What remains is exact by construction: a hand-set
 * bitmap font emitted as full blocks (no sampling, no threshold, no noise),
 * and a SEEDED star scatter, so the same inputs always produce the same
 * glyphs and the mark cannot regress.
 *
 * Twinkle is NOT baked: every star cell carries its own brightness, and the
 * idle animation (logoShimmer in NemoLogo.tsx) scales each cell by a
 * position-hashed phase — brighter cells breathe harder, so the field reads
 * as twinkling metal rather than a static gradient.
 *
 * Usage: node scripts/make-logo-hex.mjs [out.txt]
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const outPath =
  process.argv[2] ??
  path.join(scriptDir, "..", "packages", "tui", "src", "ink-app", "logo_ansi.txt")

/** Terminal rows for the whole lockup: star band, then the wordmark. */
const ROWS = 8

// --- colour: an all-metal palette, stars brightest ----------------------------

/** Steel grey, the dimmest stars. */
const STEEL_DARK = [88, 102, 120]
/** Bright steel, the wordmark body. */
const STEEL = [148, 164, 184]
/** Near-white silver, the lit wordmark edge and bright stars. */
const SILVER = [228, 236, 246]
/** Spark white, a few hottest stars only. */
const SPARK = [248, 250, 253]

const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t))
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

// --- the wordmark ---------------------------------------------------------------

/**
 * A 5-row bitmap font. Each glyph is 6 columns wide; `#` is ink.
 *
 * Hand-set rather than derived: a 6x5 cell font has no mechanical derivation,
 * and the letterforms are the single most-looked-at thing on the welcome
 * screen. Every glyph was drawn by eye and checked by rendering the banner.
 */
const FONT = {
  N: ["##..##", "###.##", "######", "##.###", "##..##"],
  E: ["######", "##....", "#####.", "##....", "####.."],
  M: ["##..##", "######", "######", "##..##", "##..##"],
  O: [".####.", "##..##", "##..##", "##..##", ".####."],
  C: [".#####", "##....", "##....", "##....", "..####"],
  L: ["##....", "##....", "##....", "##....", "####.."],
  I: ["######", ".####.", "..##..", "..##..", ".####."],
}

const WORDMARK = "NEMO CLI"
const WORDMARK_ROWS = 5
/** Blank columns between letters. */
const LETTER_GAP = 2
/** Blank columns before the wordmark. */
const LEFT_MARGIN = 6

/** Cell columns the wordmark occupies, including trailing gaps. */
const WORDMARK_WIDTH = [...WORDMARK].reduce(
  (w, ch) => w + (FONT[ch] ? FONT[ch][0].length : 2) + LETTER_GAP,
  0,
)
const COLS = LEFT_MARGIN + WORDMARK_WIDTH
const WORDMARK_TOP = ROWS - WORDMARK_ROWS

/**
 * Which wordmark cell holds ink. Returns the glyph row for blending, or null.
 */
function wordmarkAt(cx, cy) {
  const col = cx - LEFT_MARGIN
  const row = cy - WORDMARK_TOP
  if (row < 0 || row >= WORDMARK_ROWS) return null
  let x = 0
  for (const ch of WORDMARK) {
    const glyphDef = FONT[ch]
    const w = glyphDef ? glyphDef[0].length : 2
    if (col >= x && col < x + w) {
      return glyphDef && glyphDef[row][col - x] === "#" ? row : null
    }
    x += w + LETTER_GAP
  }
  return null
}

// --- the starfield ----------------------------------------------------------------

/**
 * Deterministic PRNG (mulberry32). The scatter MUST be seeded: an unseeded
 * Math.random would rearrange the sky on every regeneration, and the asset
 * tests pin exact rows — a wandering starfield would fail them at random.
 */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Star tiers, dimmest first. Most stars are dim steel pinpricks; a few are
 * bright silver; two or three are spark white. The twinkle animation scales
 * each cell by its own brightness, so the tiers also read as depth — dim
 * stars barely breathe, sparks flash.
 */
const STAR_TIERS = [
  { color: STEEL_DARK, weight: 0.62 },
  { color: STEEL, weight: 0.24 },
  { color: SILVER, weight: 0.11 },
  { color: SPARK, weight: 0.03 },
]

function pickTier(rand) {
  let t = rand()
  for (const tier of STAR_TIERS) {
    t -= tier.weight
    if (t <= 0) return tier.color
  }
  return STAR_TIERS[0].color
}

/**
 * Where the stars live: the band above the wordmark, and nothing else, so the
 * letter rows stay deterministic (the asset tests pin their ink per row).
 */
const STAR_ROWS_TOP = WORDMARK_TOP
const rand = mulberry32(0x51a17)
const stars = new Map()
for (let cy = 0; cy < ROWS; cy++) {
  for (let cx = 0; cx < COLS; cx++) {
    if (wordmarkAt(cx, cy) !== null) continue
    if (cy >= STAR_ROWS_TOP) continue
    if (rand() > 0.1) continue
    stars.set(`${cx},${cy}`, pickTier(rand))
  }
}

// --- colour -------------------------------------------------------------------------

/**
 * Colour for a cell. The wordmark runs steel to silver toward the upper
 * right, like one light source; stars keep their tier colour exactly, so the
 * twinkle animation has true brightness levels to work with.
 */
function colorFor(cx, cy, layer) {
  if (layer === "star") return stars.get(`${cx},${cy}`)
  const t = clamp01((cx / (COLS - 1)) * 0.45 + (1 - cy / (ROWS - 1)) * 0.55)
  return t < 0.5 ? mix(STEEL_DARK, STEEL, t * 2) : mix(STEEL, SILVER, (t - 0.5) * 2)
}

const SGR = (rgb) => `\x1b[38;2;${rgb.join(";")}m`
const lines = []
for (let cy = 0; cy < ROWS; cy++) {
  let line = ""
  for (let cx = 0; cx < COLS; cx++) {
    const wordRow = wordmarkAt(cx, cy)
    const star = stars.get(`${cx},${cy}`)
    if (wordRow === null && !star) {
      line += " "
      continue
    }
    // A star never overwrites a letter (guarded at scatter time); the layer
    // flag only decides the palette.
    const layer = wordRow !== null ? "word" : "star"
    line += `\x1b[0m${SGR(colorFor(cx, cy, layer))}\u2588`
  }
  lines.push(line.replace(/\s+$/, "") + "\x1b[0m")
}

// Drop fully blank edge rows so the banner carries no dead space. With the
// star band on top there should be none left, but a regeneration with a
// different seed must never silently grow the frame — the theme picker's row
// budget is asserted against this file.
while (lines.length > 0 && !/[^\s\x1b]/.test(lines[0].replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))) lines.shift()
while (lines.length > 0 && !/[^\s\x1b]/.test(lines[lines.length - 1].replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))) lines.pop()

fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8")
const inkCells = [...fs.readFileSync(outPath, "utf8").matchAll(/\u2588/g)].length
process.stdout.write(
  `rows=${lines.length} cols=${COLS} ink=${inkCells} stars=${stars.size} ` +
    `bytes=${fs.statSync(outPath).size} (wordmark "${WORDMARK}" + starfield)\n`,
)
