/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"
import { isMarkdownFilePath } from "./is-markdown-file-path.js"

describe("isMarkdownFilePath", () => {
  it("accepts every markdown flavour in the extension list", () => {
    for (const ext of [".md", ".mdx", ".markdown", ".mkdn", ".mkd", ".mdown", ".rmd"]) {
      expect(isMarkdownFilePath(`notes${ext}`), ext).toBe(true)
    }
  })

  it("is case-insensitive on the extension", () => {
    expect(isMarkdownFilePath("README.MD")).toBe(true)
    expect(isMarkdownFilePath("Readme.MdX")).toBe(true)
  })

  it("matches only the final extension, dots in the name included", () => {
    expect(isMarkdownFilePath("v1.2.notes.md")).toBe(true)
    expect(isMarkdownFilePath("notes.md.txt")).toBe(false)
  })

  it("rejects non-markdown and extensionless paths", () => {
    expect(isMarkdownFilePath("main.ts")).toBe(false)
    expect(isMarkdownFilePath("Makefile")).toBe(false)
  })
})
