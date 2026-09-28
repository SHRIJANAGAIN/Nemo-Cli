#!/usr/bin/env node
/* convert-skt-themes.mjs — one-shot port of SKT AI LABS Code's TUI theme JSONs
 * (opencode theme schema) into trayambak PaletteSpec definitions.
 *
 * Reads : SKT AI LABS-main/packages/tui/src/theme/assets/*.json (36 files)
 * Writes: packages/tui/src/ui/skt-themes.ts
 *
 * Mirrors SKT AI LABS's resolveTheme() with mode pinned to "dark":
 *   - { dark, light } variants  -> dark side
 *   - refs                      -> defs map, then other theme tokens (cycle-checked)
 *   - ANSI numbers 0-255        -> xterm palette (SKT AI LABS's exact table)
 *   - "transparent" / "none"    -> #000000 (Ink has no alpha; warns)
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SRC = "C:/Users/engli/OneDrive/Documents/tool/SKT AI LABS-main/packages/tui/src/theme/assets"
const OUT = fileURLToPath(new URL("../packages/tui/src/ui/skt-themes.ts", import.meta.url))

const warnings = []

const ANSI = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
]

const rgbHex = (r, g, b) => "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")

/** SKT AI LABS's ansiToRgba(), expressed as #rrggbb. */
function ansiToHex(code) {
  if (code < 16) return ANSI[code] ?? "#000000"
  if (code < 232) {
    const i = code - 16
    const b = i % 6
    const g = Math.floor(i / 6) % 6
    const r = Math.floor(i / 36)
    const v = (x) => (x === 0 ? 0 : x * 40 + 55)
    return rgbHex(v(r), v(g), v(b))
  }
  if (code < 256) {
    const gy = (code - 232) * 10 + 8
    return rgbHex(gy, gy, gy)
  }
  return "#000000"
}

function normalizeHex(h, where) {
  let s = h.slice(1)
  if (s.length === 3)
    s = s
      .split("")
      .map((x) => x + x)
      .join("")
  if (s.length === 8) {
    const a = parseInt(s.slice(6, 8), 16)
    if (a !== 255) warnings.push(`${where}: alpha stripped from ${h} (Ink has no alpha)`)
    s = s.slice(0, 6)
  }
  if (s.length !== 6 || /[^0-9a-f]/i.test(s)) throw new Error(`Unsupported hex: ${h}`)
  return "#" + s.toLowerCase()
}

/** SKT AI LABS's resolveColor() with mode fixed to "dark". Chain seeds empty, exactly
 * like SKT AI LABS: a token may legitimately reference its own def name. */
function resolveColor(c, defs, themeMap, chain, where) {
  if (typeof c === "number") return ansiToHex(c)
  if (typeof c === "string") {
    if (c === "transparent" || c === "none") {
      warnings.push(`${where}: transparent -> #000000 (Ink has no alpha)`)
      return "#000000"
    }
    if (c.startsWith("#")) return normalizeHex(c, where)
    if (chain.includes(c)) {
      throw new Error(`Circular color reference: ${[...chain, c].join(" -> ")}`)
    }
    const next = defs[c] ?? themeMap[c]
    if (next === undefined) {
      throw new Error(`Color reference "${c}" not found (chain: ${chain.join(" -> ")})`)
    }
    return resolveColor(next, defs, themeMap, [...chain, c], where)
  }
  if (c && typeof c === "object" && "dark" in c) {
    return resolveColor(c.dark, defs, themeMap, chain, where)
  }
  throw new Error(`Unsupported color value: ${JSON.stringify(c)}`)
}

function emitC(c) {
  const parts = Object.entries(c).map(([k, v]) => `${k}: "${v}"`)
  const lines = []
  let line = "      "
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i] + (i < parts.length - 1 ? "," : "")
    if (line.length > 8 && line.length + seg.length + 1 > 100) {
      lines.push(line.trimEnd())
      line = "      " + seg + " "
    } else {
      line += seg + " "
    }
  }
  if (line.trim()) lines.push(line.trimEnd())
  return lines.join("\n")
}

const files = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".json"))
  .sort()
if (files.length === 0) {
  console.error(`No theme JSONs found in ${SRC}`)
  process.exit(1)
}

const specs = []
const seen = new Set()
for (const file of files) {
  const json = JSON.parse(fs.readFileSync(path.join(SRC, file), "utf8"))
  const name = file.replace(/\.json$/i, "")
  if (seen.has(name)) throw new Error(`Duplicate theme name: ${name}`)
  seen.add(name)
  const defs = json.defs ?? {}
  const themeMap = json.theme ?? {}
  const c = {}
  let thinkingOpacity
  for (const [key, value] of Object.entries(themeMap)) {
    if (key === "thinkingOpacity") {
      if (typeof value === "number") thinkingOpacity = value
      continue
    }
    try {
      c[key] = resolveColor(value, defs, themeMap, [], `${name}.${key}`)
    } catch (err) {
      warnings.push(`${name}.${key}: ${err.message} (dropped — build() will fall back)`)
      delete c[key]
    }
  }
  specs.push({ name, dark: true, thinkingOpacity, c })
}
specs.sort((a, b) => a.name.localeCompare(b.name))

const blocks = specs.map((s) => {
  const head = ["  {", `    name: "${s.name}",`, "    dark: true,"]
  if (s.thinkingOpacity !== undefined) head.push(`    thinkingOpacity: ${s.thinkingOpacity},`)
  head.push("    c: {", emitC(s.c), "    },", "  },")
  return head.join("\n")
})

const code = `/* AUTO-GENERATED by scripts/convert-skt-themes.mjs — do not edit by hand.
 * SKT AI LABS Code TUI palettes (opencode theme schema), dark-mode side of each
 * palette. Regenerate: node scripts/convert-skt-themes.mjs
 */
import type { PaletteSpec } from "./theme.js";

export const SKT_SPECS: PaletteSpec[] = [
${blocks.join("\n\n")}
];
`

fs.writeFileSync(OUT, code)
console.log(`Wrote ${specs.length} specs -> ${OUT}`)
if (specs.length !== 36) {
  console.error(`Expected 36 theme JSONs, got ${specs.length}`)
  process.exitCode = 1
}
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const w of warnings) console.log(`  - ${w}`)
} else {
  console.log("No warnings.")
}
