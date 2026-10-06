/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { formatClock, formatDate, shortPath } from "./WelcomeScreen.js"

describe("formatClock", () => {
  it("zero-pads hours, minutes and seconds", () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4, 5))).toBe("03:04:05")
    expect(formatClock(new Date(2026, 0, 2, 23, 59, 59))).toBe("23:59:59")
    expect(formatClock(new Date(2026, 0, 2, 0, 0, 0))).toBe("00:00:00")
    expect(formatClock(new Date(2026, 0, 2, 9, 8, 7))).toBe("09:08:07")
  })

  it("always renders HH:MM:SS (8 chars) so the line never reflows", () => {
    for (let h = 0; h < 24; h += 1) {
      expect(formatClock(new Date(2026, 0, 2, h, 0, 0))).toHaveLength(8)
    }
  })
})

describe("formatDate", () => {
  it("renders an ASCII weekday + month + day", () => {
    expect(formatDate(new Date(2026, 0, 2, 12))).toBe("Fri Jan 2")
    expect(formatDate(new Date(2026, 11, 25, 12))).toBe("Fri Dec 25")
  })

  it("never emits non-ASCII (mojibake guard for legacy consoles)", () => {
    for (let d = 0; d < 365; d += 1) {
      const line = formatDate(new Date(2026, 0, 1 + d, 12))
      expect(line).toMatch(/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2}$/)
      expect(/^[\x20-\x7e]+$/.test(line)).toBe(true)
    }
  })
})

describe("shortPath", () => {
  it("keeps short paths whole", () => {
    expect(shortPath("C:/a/b")).toBe("C:/a/b")
    expect(shortPath("C:\\a\\b")).toBe("C:\\a\\b")
  })

  it("keeps the drive plus the newest folders, eliding the middle", () => {
    // A shown root ("C:") spends one of the 3 segments: drive + 2 folders.
    expect(shortPath("C:/Users/engli/trayambak")).toBe("C:/.../engli/trayambak")
    expect(shortPath("C:/a/b/c/d/e/f")).toBe("C:/.../e/f")
  })

  it("trims a trailing separator and handles no path", () => {
    expect(shortPath("C:/a/b/")).toBe("C:/a/b")
    expect(shortPath(undefined)).toBe("")
    expect(shortPath("")).toBe("")
  })

  it("keeps 3 folders when the first segment is not a root", () => {
    // "home" is a real folder name (too long to be a root), so no prefix.
    expect(shortPath("/home/engli/projects/app")).toBe(".../engli/projects/app")
  })
})