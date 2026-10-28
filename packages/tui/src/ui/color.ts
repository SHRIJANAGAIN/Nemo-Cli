/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Port of the Codex reference `color.rs`
 * -- YIQ luminance, linear blend, and CIE76 perceptual distance.
 */

export type Rgb = readonly [number, number, number]

export function isLight(rgb: Rgb): boolean {
  const [r, g, b] = rgb
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  return y > 128
}

export function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  const ar = fg[0] * alpha + bg[0] * (1 - alpha)
  const ag = fg[1] * alpha + bg[1] * (1 - alpha)
  const ab = fg[2] * alpha + bg[2] * (1 - alpha)
  return [ar, ag, ab]
}

function srgbToLinear(c: number): number {
  const v = c / 255
  if (v <= 0.04045) return v / 12.92
  return Math.pow((v + 0.055) / 1.055, 2.4)
}

function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const x = lr * 0.4124 + lg * 0.3576 + lb * 0.1805
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722
  const z = lr * 0.0193 + lg * 0.1192 + lb * 0.9505
  return [x, y, z]
}

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const xr = x / 0.95047
  const yr = y / 1.0
  const zr = z / 1.08883

  function f(t: number): number {
    if (t > 0.008856) return Math.pow(t, 1 / 3)
    return 7.787 * t + 16 / 116
  }

  const fx = f(xr)
  const fy = f(yr)
  const fz = f(zr)

  const l = 116 * fy - 16
  const a = 500 * (fx - fy)
  const b = 200 * (fy - fz)
  return [l, a, b]
}

export function perceptualDistance(a: Rgb, b: Rgb): number {
  const [x1, y1, z1] = rgbToXyz(a[0], a[1], a[2])
  const [x2, y2, z2] = rgbToXyz(b[0], b[1], b[2])

  const [l1, a1, b1] = xyzToLab(x1, y1, z1)
  const [l2, a2, b2] = xyzToLab(x2, y2, z2)

  const dl = l1 - l2
  const da = a1 - a2
  const db = b1 - b2

  return Math.sqrt(dl * dl + da * da + db * db)
}
