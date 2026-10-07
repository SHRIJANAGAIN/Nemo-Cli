/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { ABOUT_HEADING, ABOUT_PARAGRAPHS, ABOUT_WEBSITE, formatAbout } from "./about.js"
import { SLASH_COMMANDS } from "./types.js"

describe("/about", () => {
  it("is listed in the slash chooser as About Us", () => {
    const about = SLASH_COMMANDS.find((c) => c.name === "about")
    expect(about).toBeDefined()
    expect(about?.category).toBe("General")
    expect(ABOUT_HEADING).toBe("ABOUT US")
  })

  it("renders the heading followed by every paragraph", () => {
    const out = formatAbout()
    expect(out.startsWith(ABOUT_HEADING)).toBe(true)
    for (const p of ABOUT_PARAGRAPHS) {
      expect(out).toContain(p)
    }
  })

  it("ends with the website", () => {
    const out = formatAbout()
    expect(out).toContain(ABOUT_WEBSITE)
    expect(out.trimEnd().endsWith(ABOUT_WEBSITE)).toBe(true)
  })

  it("keeps the factual claims intact (dates, founder, model id)", () => {
    const out = formatAbout()
    for (const fact of [
      "March 2023",
      "Sidhi, Madhya Pradesh",
      "Shrijan Kumar Tiwari",
      "SKT AI LABS Private Limited",
      "August 2026",
      "SKT-ST-X-0-3B",
      "July 2026",
      "model card",
    ]) {
      expect(out).toContain(fact)
    }
  })

  it("is pure ASCII (mojibake guard for non-UTF8 consoles)", () => {
    // Long prose makes one smart quote or em dash visible; the rest of the UI
    // guards its marks the same way.
    expect(/^[\x20-\x7e\n]*$/.test(formatAbout())).toBe(true)
  })
})