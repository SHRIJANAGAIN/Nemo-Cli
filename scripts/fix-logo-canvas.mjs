/* Art fix: logo_ansi.txt paints its canvas as #121212 with PNG-export noise
 * (near-black darks 16..21) and dark anti-aliasing into margin/corner cells,
 * so on a pure-black terminal the logo shows a grey box — first the full box
 * ("background black se match nahi karta"), then its corner specks after the
 * first pass ("logo corner are left").
 *
 * Cell structure: \e[38;2;fgm\e[48;2;bgm<glyph>\e[0m  (400 cells, 40x10)
 * or the already-fixed \e[38;2;fgm\e[49m<glyph>\e[0m form.
 * Glyph U+2580 (▀): fg = top half, bg = bottom half.
 * Glyph U+2584 (▄): fg = bottom half, bg = top half.
 *
 * Rule (feather pixels untouched — genuine edge AA starts around max 110,
 * noise/canvas darks are all <= 90):
 *   half with max(RGB) <= 90  ->  transparent (terminal background shows)
 *   both halves dark          ->  " "
 *   top dark, bottom art      ->  fg=art, bg=\e[49m, glyph ▄
 *   bottom dark, top art      ->  fg=art, bg=\e[49m, glyph ▀
 *
 * Run: node scripts/fix-logo-canvas.mjs        (idempotent — no-op once clean)
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const logoPath = path.join(here, "..", "packages", "tui", "src", "ink-app", "logo_ansi.txt")
const backupPath = `${logoPath}.orig`
const DARK_MAX = 90

const raw = fs.readFileSync(logoPath, "utf8")
if (!fs.existsSync(backupPath)) fs.copyFileSync(logoPath, backupPath)

const cell = /\x1b\[38;2;(\d+);(\d+);(\d+)m(?:\x1b\[48;2;(\d+);(\d+);(\d+)m|\x1b\[49m)(▀|▄)\x1b\[0m/g

let transparentTop = 0
let transparentBottom = 0
let cleared = 0
let cells = 0

const out = raw.replace(cell, (_all, fr, fg, fb, br, bg, bb, glyph) => {
  cells++
  const top =
    glyph === "▀"
      ? [Number(fr), Number(fg), Number(fb)]
      : br !== undefined
        ? [Number(br), Number(bg), Number(bb)]
        : null
  const bottom =
    glyph === "▄"
      ? [Number(fr), Number(fg), Number(fb)]
      : br !== undefined
        ? [Number(br), Number(bg), Number(bb)]
        : null
  const topDark = top === null || Math.max(...top) <= DARK_MAX
  const bottomDark = bottom === null || Math.max(...bottom) <= DARK_MAX
  if (topDark && bottomDark) {
    cleared++
    return " "
  }
  if (topDark) {
    if (br === undefined) return _all // already the 49m form: top transparent, bottom art -> fine
    transparentTop++
    return `\x1b[38;2;${br};${bg};${bb}m\x1b[49m▄\x1b[0m`
  }
  if (bottomDark) {
    transparentBottom++
    return `\x1b[38;2;${fr};${fg};${fb}m\x1b[49m▀\x1b[0m`
  }
  return _all
})

// Cells still in code form + cells already reduced to a plain space must total 400.
const spacesBefore = (raw.match(/ /g) ?? []).length
if (cells + spacesBefore !== 400) {
  console.error(`ABORT: parsed ${cells} cells + ${spacesBefore} spaces != 400 (glyph/structure drift?)`)
  process.exit(1)
}

const spaces = (out.match(/ /g) ?? []).length
const glyphs = (out.match(/[▀▄]/g) ?? []).length
fs.writeFileSync(logoPath, out)
console.log(
  `cells cleared to space: ${cleared} | top made transparent: ${transparentTop} | bottom: ${transparentBottom}`,
)
console.log(`units after: ${spaces} spaces + ${glyphs} glyphs = ${spaces + glyphs} (want 400)`)
if (spaces + glyphs !== 400) process.exit(1)

// Any remaining dark half would still speck the corners on a black terminal.
const leftover = [...out.matchAll(cell)].filter((m) => {
  const g = m[7]
  const fg = [Number(m[1]), Number(m[2]), Number(m[3])]
  const bg = m[4] !== undefined ? [Number(m[4]), Number(m[5]), Number(m[6])] : null
  const top = g === "▀" ? fg : bg
  const bottom = g === "▄" ? fg : bg
  return (top && Math.max(...top) <= DARK_MAX) || (bottom && Math.max(...bottom) <= DARK_MAX)
}).length
console.log(`dark halves left: ${leftover} (must be 0)`)
if (leftover > 0) process.exit(1)
console.log(`OK: ${path.relative(process.cwd(), logoPath)} (original: ${path.basename(backupPath)})`)
