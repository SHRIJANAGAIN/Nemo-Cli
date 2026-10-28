/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, it } from "vitest"
import { matchGlob } from "./fs-walk.js"

describe("matchGlob single-char wildcard", () => {
  it("treats ? as any single char (glob semantics), not a regex quantifier", () => {
    // The escape class omits `?`, so `file?.txt` became regex `file?.txt`
    // ("e" optional): fil.txt matched (phantom) and file1.txt did NOT (miss).
    // The ripgrep backend supports `?`; the Node fallback disagreed.
    expect(matchGlob("file?.txt", "file1.txt")).toBe(true) // RED: false
    expect(matchGlob("file?.txt", "fil.txt")).toBe(false) // RED: true
    expect(matchGlob("file?.txt", "file.txt")).toBe(false)
  })
})