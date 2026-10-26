/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, it, expect } from "vitest"
import { fitFooter, truncateTo, versionChipText, FRAME_OVERHEAD, SEGMENT_GAP } from "./footer-fit.js"

/** Reproduces the real overflow from the bug report: a 36-char model name
 *  plus every optional segment at a ~122-col terminal. */
const fullInput = (columns: number) => ({
  columns,
  model: "nvidia/nemotron-3-super-120b-a12b",
  statusText: "idle",
  modeText: "Mode: ASK",
  tokenText: "Tokens: 0",
  bgText: "BG: 2",
  queueText: ">> Queue: 1",
  spinner: true,
  bgHint: "ctrl+b bg",
  taskHint: "✓ task finished — Ctrl+B to view",
  subagentLabels: ["○ audit (12s) · running", "● scan (3s) · completed", "◍ lint (44s) · running"],
  hintVariants: [
    "ctrl+s subagents / ctrl+b background / ctrl+k keys / ctrl+p commands / ctrl+x clear queue",
    "ctrl+s sub / ctrl+b bg / ctrl+k keys / ctrl+p cmd",
    "ctrl+k/ctrl+p",
  ],
})

/** Rebuild the rendered row width exactly as Footer lays it out. */
const renderedWidth = (fit: ReturnType<typeof fitFooter>): number =>
  (fit.model.length > 0 ? fit.model.length + SEGMENT_GAP : 0) +
  fit.segments.reduce((sum, seg, i) => sum + seg.text.length + (i > 0 ? SEGMENT_GAP : 0), 0)

describe("truncateTo", () => {
  it("passes through when it fits", () => {
    expect(truncateTo("abc", 3)).toBe("abc")
    expect(truncateTo("abc", 10)).toBe("abc")
  })

  it("cuts to max-1 plus an ellipsis", () => {
    expect(truncateTo("abcdefgh", 5)).toBe("abcd…")
    expect(truncateTo("abcdefgh", 1)).toBe("…")
  })

  it("returns empty at zero or below", () => {
    expect(truncateTo("abc", 0)).toBe("")
    expect(truncateTo("abc", -3)).toBe("")
    expect(truncateTo("", 5)).toBe("")
  })
})

describe("fitFooter", () => {
  it("derives inner width from terminal columns minus frame overhead", () => {
    // 6 = root border 2 + footer section border 2 + footer padding 2.
    expect(FRAME_OVERHEAD).toBe(6)
    const fit = fitFooter(fullInput(122))
    expect(fit.inner).toBe(116)
  })

  it("fits every line at 122 cols (the reported overflow)", () => {
    const fit = fitFooter(fullInput(122))
    expect(fit.width).toBeLessThanOrEqual(fit.inner)
    expect(renderedWidth(fit)).toBe(fit.width)
    expect(fit.fits).toBe(true)
  })

  it("fits at 120, 80, and 60 cols", () => {
    for (const columns of [120, 80, 60]) {
      const fit = fitFooter(fullInput(columns))
      expect(fit.width, `width at ${columns} cols`).toBeLessThanOrEqual(fit.inner)
      expect(fit.fits, `fits at ${columns} cols`).toBe(true)
      expect(fit.segments.some((s) => s.id === "status")).toBe(true)
      expect(fit.segments.some((s) => s.id === "mode")).toBe(true)
      expect(fit.segments.some((s) => s.id === "tokens")).toBe(true)
    }
  })

  it("keeps core segments (status/mode/tokens) visible at every width", () => {
    for (const columns of [60, 80, 120, 200]) {
      const ids = fitFooter(fullInput(columns)).segments.map((s) => s.id)
      expect(ids).toContain("status")
      expect(ids).toContain("mode")
      expect(ids).toContain("tokens")
    }
  })

  it("shows full hints when there is slack, drops to shorter hints when tight", () => {
    // Wide + light load: core-only right block leaves >86 cols of slack,
    // so the FULL hint variant must be chosen (fullInput(200) with every
    // optional segment deliberately spends the slack on optionals first).
    const wide = fitFooter({
      columns: 200,
      model: "nvidia/nemotron-3-super-120b-a12b",
      statusText: "idle",
      modeText: "Mode: ASK",
      tokenText: "Tokens: 0",
      hintVariants: fullInput(200).hintVariants,
    })
    const hint = wide.segments.find((s) => s.id === "hints")
    expect(hint?.text).toContain("ctrl+s subagents")

    //80 cols: full hint (86 chars) cannot fit beside model + optionals.
    const tight = fitFooter(fullInput(80))
    const tightHint = tight.segments.find((s) => s.id === "hints")
    if (tightHint) {
      expect(tightHint.text.length).toBeLessThan(86)
    }
    expect(tight.fits).toBe(true)
  })

  it("drops hints entirely before ever splitting the model", () => {
    const fit = fitFooter(fullInput(60))
    expect(fit.fits).toBe(true)
    expect(fit.width).toBeLessThanOrEqual(fit.inner)
    // model must be intact or ellipsized — never two pieces
    expect(fit.model.endsWith("…") || fit.model.length <= 36).toBe(true)
  })

  it("truncates a long model with an ellipsis instead of wrapping", () => {
    const fit = fitFooter({
      columns: 60,
      model: "nvidia/nemotron-3-super-120b-a12b",
      statusText: "idle",
      modeText: "Mode: ASK",
      tokenText: "Tokens: 0",
    })
    expect(fit.model).toContain("…")
    expect(fit.width).toBeLessThanOrEqual(fit.inner)
  })

  it("drops optionals in priority order under pressure, core survives", () => {
    const ids = fitFooter(fullInput(60)).segments.map((s) => s.id)
    expect(ids).toContain("status")
    expect(ids).toContain("mode")
    expect(ids).toContain("tokens")
    // tight width → the longest optionals (chips, task hint) go first
    expect(ids.some((id) => id.startsWith("chip:"))).toBe(false)
    expect(ids).not.toContain("task-hint")
  })

  it("keeps operationally-critical counts (bg/queue) as long as they fit", () => {
    const fit = fitFooter(fullInput(120))
    const ids = fit.segments.map((s) => s.id)
    expect(ids).toContain("bg")
    expect(ids).toContain("queue")
    expect(ids).toContain("spinner")
  })

  it("shows the scroll-depth chip right after queue while parked, absent at live", () => {
    // The chip appears the moment a mid-turn notch parks the window.
    const parked = fitFooter({ ...fullInput(120), scrollText: "↑ 5", versionText: "v0.6.7", ctxText: "ctx 12%" })
    const ids = parked.segments.map((s) => s.id)
    expect(ids).toContain("scroll")
    expect(parked.segments.find((s) => s.id === "scroll")?.text).toBe("↑ 5")
    expect(ids.indexOf("queue")).toBeLessThan(ids.indexOf("scroll"))
    expect(ids.indexOf("scroll")).toBeLessThan(ids.indexOf("ctx"))
    // Build identity travels with it; live (neither text) stays byte-identical.
    expect(ids).toContain("version")
    expect(parked.segments.find((s) => s.id === "version")?.text).toBe("v0.6.7")
    expect(ids.indexOf("scroll")).toBeLessThan(ids.indexOf("version"))
    expect(fitFooter(fullInput(120)).segments.map((s) => s.id)).not.toContain("scroll")
    expect(fitFooter(fullInput(120)).segments.map((s) => s.id)).not.toContain("version")
  })

  it("never lets optionals push the model below its floor", () => {
    const fit = fitFooter(fullInput(120))
    expect(fit.model.length).toBeGreaterThanOrEqual(12)
  })

  it("chip shows the S-series codename, not the raw semver prerelease", () => {
    // npm forces semver, so "1.0.0-S1-TITANIUM" is the real version string;
    // the chip prints the codename (18 cols of prerelease noise dropped).
    expect(versionChipText("1.0.0-S1-TITANIUM")).toBe("S1-TITANIUM")
    // A plain semver build keeps the historic shape.
    expect(versionChipText("0.6.7")).toBe("v0.6.7")
    expect(versionChipText("1.0.0")).toBe("v1.0.0")
    // A non-semver string is never mistaken for a codename.
    expect(versionChipText("weird-build")).toBe("vweird-build")
  })

  it("handles absurdly narrow terminals without producing a negative fit", () => {
    const fit = fitFooter(fullInput(20))
    expect(fit.inner).toBeGreaterThanOrEqual(10)
    expect(fit.width).toBeGreaterThanOrEqual(0)
    // core is attempted even if it can't fit — Footer truncates as net
    expect(fit.segments.map((s) => s.id)).toEqual(expect.arrayContaining(["status", "mode", "tokens"]))
  })

  it("omits empty optionals", () => {
    const fit = fitFooter({
      columns: 200,
      model: "nemo",
      statusText: "thinking",
      modeText: "Mode: PLAN",
      tokenText: "Tokens: 1234",
    })
    expect(fit.segments.map((s) => s.id)).toEqual(["status", "mode", "tokens"])
  })

  it("adds a ctx % segment when provided (Shrijan context indicator), after tokens", () => {
    const fit = fitFooter({
      columns: 160,
      model: "nemo",
      statusText: "idle",
      modeText: "Mode: ASK",
      tokenText: "Tokens: 12000",
      ctxText: "ctx 12%",
    })
    const ids = fit.segments.map((s) => s.id)
    expect(ids.indexOf("ctx")).toBeGreaterThan(ids.indexOf("tokens"))
    expect(fit.segments.find((s) => s.id === "ctx")?.text).toBe("ctx 12%")
    expect(fit.fits).toBe(true)
  })

  it("sacrifices ctx before core segments when the row gets tight", () => {
    const fit = fitFooter({
      columns: 60,
      model: "nvidia/nemotron-3-super-120b-a12b",
      statusText: "idle",
      modeText: "Mode: READ-ONLY",
      tokenText: "Tokens: 123456",
      ctxText: "ctx 87%",
    })
    const ids = fit.segments.map((s) => s.id)
    expect(ids).toContain("status")
    expect(ids).toContain("mode")
    expect(ids).toContain("tokens")
    expect(ids).not.toContain("ctx")
    expect(fit.fits).toBe(true)
  })

  it("reproduces the exact bug-report row within budget at 122 cols", () => {
    // The screenshot: model 36 + status + Mode + Tokens + hints ≈ 160 cols
    // crammed into ~116 usable — previously wrapped mid-word.
    const fit = fitFooter({
      columns: 122,
      model: "nvidia/nemotron-3-super-120b-a12b",
      statusText: "idle",
      modeText: "Mode: ASK",
      tokenText: "Tokens: 0",
      hintVariants: [
        "ctrl+s subagents / ctrl+b background / ctrl+k keys / ctrl+p commands",
        "ctrl+s sub / ctrl+b bg / ctrl+k keys / ctrl+p cmd",
        "ctrl+k/ctrl+p",
      ],
    })
    expect(fit.fits).toBe(true)
    expect(renderedWidth(fit)).toBeLessThanOrEqual(fit.inner)
    // model intact (no truncation needed for the core-only case)
    expect(fit.model).toBe("nvidia/nemotron-3-super-120b-a12b")
    // hints must fit on the same line or be gone — never a wrapped tail
    const hint = fit.segments.find((s) => s.id === "hints")
    if (hint) {
      expect(fit.width).toBeLessThanOrEqual(fit.inner)
    }
  })
})

describe("wide glyphs (CJK/emoji count 2 columns)", () => {
  it("truncateTo never splits a 2-cell glyph and counts it as 2", () => {
    // "ab" + 3 CJK chars: widths 1+1+2+2+2 = 8; max 5 takes "ab" + one
    // CJK (4 cols) + "…" = 5 columns, never half a glyph.
    expect(truncateTo("ab日本語", 5)).toBe("ab日…")
    expect(truncateTo("ab日本語", 8)).toBe("ab日本語")
    // Emoji block counts 2 per glyph.
    expect(truncateTo("ab🚀cd", 5)).toBe("ab🚀…")
  })

  it("fitFooter measures CJK model names in columns, not chars", () => {
    const fit = fitFooter({
      ...fullInput(122),
      model: "日本語モデル-12345678901234567890",
    })
    expect(fit.width).toBeLessThanOrEqual(fit.inner)
    expect(fit.fits).toBe(true)
  })
})
