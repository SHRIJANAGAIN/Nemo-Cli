/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { INSTALL_PS1 } from "./install-ps1.js"

describe("INSTALL_PS1", () => {
  /** Code lines only: header comments legitimately reference the served URL. */
  const codeLines = (): string =>
    INSTALL_PS1.split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n")

  /** Every URL the installer touches must be first-party infrastructure. */
  const contactedHosts = (): string[] =>
    [...codeLines().matchAll(/https?:\/\/[^\s"'\)]+/g)].map((m) =>
      new URL(m[0].replace(/[.,;:!?]+$/, "")).hostname.toLowerCase(),
    )

  it("installs the published scope, verifies, and guides — nothing else", () => {
    expect(INSTALL_PS1).toContain("npm install -g @shrijanagain/nemo-cli")
    expect(INSTALL_PS1).toContain("nemo --version")
    expect(INSTALL_PS1).toContain("/provider add")
    expect(INSTALL_PS1).toContain("/github login")
    // Node bootstrap: winget first, official nodejs.org MSI fallback.
    expect(INSTALL_PS1).toContain("winget")
    expect(INSTALL_PS1).toContain("OpenJS.NodeJS.LTS")
    expect(INSTALL_PS1).toContain("msiexec")
    expect(INSTALL_PS1).toContain("nodejs.org/dist")
    // Branded loader: full clear, gradient banner, eye-opening ceremony, italic tagline.
    expect(INSTALL_PS1).toContain("Clear-Host")
    expect(INSTALL_PS1).toContain("three eyes of Shiva is coming")
    expect(INSTALL_PS1).toContain("[char]27")
    expect(INSTALL_PS1).toContain("T R A Y A M B A K")
    expect(INSTALL_PS1).toContain("opening the third eye")
    // Download animation around the install (comet bar + eye spinner + elapsed + fallback).
    expect(INSTALL_PS1).toContain("Start-Job")
    expect(INSTALL_PS1).toContain("elapsed")
    // No secrets, no side channels, no third-party binaries (DownloadFile
    // only ever targets nodejs.org — proven by the host pin below).
    expect(codeLines()).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|curl|wget/i)
    expect(INSTALL_PS1).not.toMatch(/password|secret|token/i)
    for (const host of contactedHosts()) {
      expect(["nodejs.org", "registry.npmjs.org"]).toContain(host)
    }
  })
})
