/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The `/about` text — who builds Nemo.
 *
 * One source of truth: the TUI slash command renders these exact paragraphs, so
 * the founding story, dates and model names can never drift between surfaces.
 * ASCII only (no smart quotes, no em dashes, no emoji): the UI's other marks
 * are guarded for the same reason — they render as mojibake on a non-UTF8
 * console, and this text is prose long enough that one bad glyph is visible.
 */

/** Short label for the lab, used as the heading. */
export const ABOUT_HEADING = "ABOUT US"

/** The lab's site. Also the domain the security contact hangs off
 *  (security.txt ships support@sktailabs.in). */
export const ABOUT_WEBSITE = "https://sktailabs.in"

/** Body paragraphs, in order. Kept verbatim: dates and the model id are
 *  factual claims, not copy to be reworded per surface. */
export const ABOUT_PARAGRAPHS: readonly string[] = [
  "Shrijan began in March 2023 in Sidhi, Madhya Pradesh, founded by Shrijan Kumar Tiwari on a simple conviction: India needs its own frontier models, and the most capable models and the safest models should be the same models. In August 2026 the lab incorporated as Shrijan Private Limited, focused on Indian frontier language models and autonomous AI systems.",
  "Our first frontier release is the bilingual Hindi-English NEMO-ST-X-0-3B, shipped July 2026 for edge devices: small, fast, and code-mix friendly. Our research continues on reasoning, agents, and multimodal understanding, and every release carries a model card covering intended use, evaluations, and known limitations.",
]

/** The full `/about` output: heading, paragraphs, then the website. Joined in
 *  one place so callers cannot disagree on the spacing. */
export function formatAbout(): string {
  return [ABOUT_HEADING, "", ...ABOUT_PARAGRAPHS, "", `web    ${ABOUT_WEBSITE}`].join("\n")
}