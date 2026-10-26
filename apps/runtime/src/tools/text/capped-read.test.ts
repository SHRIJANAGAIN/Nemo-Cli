/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { MAX_TEXT_FILE_BYTES, readFileTextCapped, readFileTextExact } from "./capped-read.js"

function withTmp(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-capped-"))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("readFileTextCapped", () => {
  it("returns the whole file and flags nothing when it fits the cap", () => {
    withTmp((dir) => {
      const p = path.join(dir, "ok.txt")
      fs.writeFileSync(p, "hello\nworld\n")
      const r = readFileTextCapped(p)
      expect(r.text).toBe("hello\nworld\n")
      expect(r.truncated).toBe(false)
      expect(r.totalBytes).toBe(12)
    })
  })

  it("reads only the prefix and reports the true size past the cap", () => {
    withTmp((dir) => {
      const p = path.join(dir, "big.txt")
      fs.writeFileSync(p, "a".repeat(MAX_TEXT_FILE_BYTES + 100))
      const r = readFileTextCapped(p, 64)
      expect(r.truncated).toBe(true)
      expect(r.text.length).toBeLessThanOrEqual(64)
      expect(r.totalBytes).toBe(MAX_TEXT_FILE_BYTES + 100)
    })
  })

  it("strips a torn multi-byte character at the truncation edge", () => {
    withTmp((dir) => {
      const p = path.join(dir, "utf8.txt")
      // "€" is 3 UTF-8 bytes; cut the buffer so the last char is torn.
      fs.writeFileSync(p, "ab€".repeat(10))
      const r = readFileTextCapped(p, 4)
      expect(r.truncated).toBe(true)
      expect(r.text).not.toContain("�")
    })
  })
})

describe("readFileTextExact", () => {
  it("reads a small file in full", () => {
    withTmp((dir) => {
      const p = path.join(dir, "ok.txt")
      fs.writeFileSync(p, "exact content")
      expect(readFileTextExact(p)).toBe("exact content")
    })
  })

  it("refuses files over the cap instead of buffering them", () => {
    withTmp((dir) => {
      const p = path.join(dir, "big.txt")
      fs.writeFileSync(p, "a".repeat(65))
      expect(() => readFileTextExact(p, 64)).toThrow(/exceeds the \d+-byte cap/)
    })
  })
})
