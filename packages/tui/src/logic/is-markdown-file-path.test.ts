/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
