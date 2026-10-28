/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { INSTALL_SH } from "./install-sh.js"

describe("INSTALL_SH", () => {
  /** Code lines only: usage comments legitimately mention curl. */
  const codeLines = (): string =>
    INSTALL_SH.split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n")

  /** Every URL the installer touches must be first-party infrastructure. */
  const contactedHosts = (): string[] =>
    [...codeLines().matchAll(/https?:\/\/[^\s"'\)]+/g)].map((m) =>
      new URL(m[0].replace(/[.,;:!?]+$/, "")).hostname.toLowerCase(),
    )

  it("installs the published scope, verifies, and guides — nothing else", () => {
    expect(INSTALL_SH).toContain("npm install -g @shrijanagain/nemo-cli")
    expect(INSTALL_SH).toContain("nemo --version")
    expect(INSTALL_SH).toContain("/provider add")
    expect(INSTALL_SH).toContain("/github login")
    // Node bootstrap: brew on mac, official nodejs.org release otherwise.
    expect(INSTALL_SH).toContain("nodejs.org/dist")
    expect(INSTALL_SH).toContain("brew install node")
    expect(INSTALL_SH).toContain("uname -m")
    // Branded loader: full clear, shimmer banner, eye-opening ceremony, italic tagline.
    expect(INSTALL_SH).toContain("T R A Y A M B A K")
    expect(INSTALL_SH).toContain("opening the third eye")
    expect(INSTALL_SH).toContain("three eyes of Shiva is coming")
    // Supervised background install (600s timeout) with a tty/plain split.
    expect(INSTALL_SH).toContain("kill -0")
    expect(INSTALL_SH).toContain("600")
    expect(INSTALL_SH).toContain("[ -t 1 ]")
    // macOS bash 3.2 + this file's template literal both forbid ${...}:
    // stages ride case branches and plain $var/$(...)/$((...)) instead.
    expect(INSTALL_SH).not.toMatch(/\$\{/)
    expect(INSTALL_SH).not.toContain("`")
    // No secrets, no side channels: the only network touches are npm and nodejs.org.
    // (The sudo "password may be asked" notice is UX, not a credential —
    // hence the assignment-shaped pin instead of a bare word match.)
    expect(codeLines()).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|DownloadFile/i)
    expect(INSTALL_SH).not.toMatch(/(password|secret|token)\s*[:=]/i)
    for (const host of contactedHosts()) {
      expect(["nodejs.org", "registry.npmjs.org"]).toContain(host)
    }
  })

  it("keeps its block structure balanced (no truncated heredoc-style edit)", () => {
    // Keywords anchored at line start: prose inside printf strings ("for
    // this session only") must not count as loop keywords.
    const code = codeLines()
      .split("\n")
      .filter((l) => /^\s*(if|fi|for|while|done|case|esac)\b/.test(l))
      .join("\n")
    const count = (re: RegExp): number => code.split(re).length - 1
    expect(count(/\bif\b/)).toBe(count(/\bfi\b/))
    // for and while both close with done.
    expect(count(/\bwhile\b/) + count(/\bfor\b/)).toBe(count(/\bdone\b/))
    expect(count(/\bcase\b/)).toBe(count(/\besac\b/))
  })
})
