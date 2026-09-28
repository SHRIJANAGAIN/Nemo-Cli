/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
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
  const fenced = new Array<boolean>(lines.length).fill(false)
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
