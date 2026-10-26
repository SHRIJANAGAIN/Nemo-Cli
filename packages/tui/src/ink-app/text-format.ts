/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/** Model soft-wrap echo ("stair-step" lines): some providers (seen with
 *  Nemotron plan-mode replies) emit hard-broken prose as "\n <line>" —
 *  every line after the first carries exactly ONE leading space, so the
 *  rendered transcript stair-steps ("lines look broken"). Verified in the
 *  persisted log.jsonl: the spaces are in the content, Ink renders them
 *  faithfully. Strip EXACTLY one leading space from lines that start with
 *  space + non-space; deeper indents (code, nested lists, tool dumps) and
 *  tab-indented lines are left untouched.
 *
 *  Fenced code blocks (``` / ~~~) are literal and never touched: without
 *  this, diff context lines (" context") and ASCII diagrams lost a column
 *  on display AND in /copy. Unclosed fence → rest-of-text treated as code
 *  (preservation wins; stair-echo prose never contains fences). */
export const normalizeStairIndent = (text: string): string => {
  if (!text.includes("\n")) return text
  const lines = text.split("\n")
  // Pass 1: mark fenced regions (fence lines included). Scans from 0 so a
  // message that STARTS with a fence is covered too.
  const fenced = new Array<boolean>(lines.length).fill(/*value*/ false)
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fenced[i] = true
      inFence = !inFence
      continue
    }
    fenced[i] = inFence
  }
  let changed = false
  for (let i = 1; i < lines.length; i += 1) {
    if (fenced[i]) continue
    const line = lines[i]
    if (line.startsWith(" ") && !line.startsWith("  ")) {
      lines[i] = line.slice(1)
      changed = true
    }
  }
  return changed ? lines.join("\n") : text
}

/**
 * Yoga OOB guard: an over-long UNBROKEN run (no spaces/tabs/newlines —
 * base64 blobs, minified JSON, model babble) forces the layout engine to
 * measure one giant line, which has crashed the renderer
 * (`RuntimeError: memory access out of bounds` in yoga's getComputedWidth,
 * observed live in the published TUI). Runs longer than `bound` code
 * points are split with real newlines — content preserved, only visual
 * wrapping added. Text that already breaks inside every window passes
 * through byte-identical (fast path: single scan, no rebuild).
 */
export const MAX_UNBROKEN_RUN = 2000

export function hardWrapLongRuns(text: string, bound: number = MAX_UNBROKEN_RUN): string {
  if (bound <= 0) return text
  const chars = [...text]
  if (chars.length <= bound) return text
  let longest = 0
  let run = 0
  for (const ch of chars) {
    if (ch === "\n" || ch === " " || ch === "\t") {
      run = 0
      continue
    }
    run += 1
    if (run > longest) longest = run
    if (longest > bound) break
  }
  if (longest <= bound) return text
  const out: string[] = []
  run = 0
  for (const ch of chars) {
    if (ch === "\n" || ch === " " || ch === "\t") {
      run = 0
      out.push(ch)
      continue
    }
    run += 1
    if (run > bound) {
      out.push("\n")
      run = 1
    }
    out.push(ch)
  }
  return out.join("")
}
