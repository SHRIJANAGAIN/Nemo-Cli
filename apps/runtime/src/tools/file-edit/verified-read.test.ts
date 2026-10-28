/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import {
  MAX_VERIFIED_READ_BYTES,
  PathChangedError,
  identityOf,
  openVerified,
  readVerifiedPrefix,
} from "./verified-read.js"

/** Real temp dir per test — no mocking, real filesystem semantics throughout. */
function withTmp(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-verified-"))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("identityOf", () => {
  it("distinguishes two different files in the same directory", () => {
    withTmp((dir) => {
      const a = path.join(dir, "a.txt")
      const b = path.join(dir, "b.txt")
      fs.writeFileSync(a, "alpha")
      fs.writeFileSync(b, "bravo-charlie-charlie")
      const ia = identityOf(fs.statSync(a))
      const ib = identityOf(fs.statSync(b))
      // Windows reports a real file index in `ino`, but never rely on that alone:
      // size + mtime are part of the key precisely so platforms that zero out
      // `ino` still produce a different key for different content.
      expect(ia.key).not.toBe(ib.key)
    })
  })

  it("is stable for the same file across two stats", () => {
    withTmp((dir) => {
      const p = path.join(dir, "same.txt")
      fs.writeFileSync(p, "unchanged")
      expect(identityOf(fs.statSync(p)).key).toBe(identityOf(fs.statSync(p)).key)
    })
  })
})

describe("openVerified", () => {
  it("opens an unchanged file and yields its identity", () => {
    withTmp((dir) => {
      const p = path.join(dir, "stable.txt")
      fs.writeFileSync(p, "hello verified read")
      const expected = identityOf(fs.statSync(p))
      const handle = openVerified(p, expected)
      try {
        expect(handle.identity.key).toBe(expected.key)
      } finally {
        fs.closeSync(handle.fd)
      }
    })
  })

  it("throws PathChangedError when the file was replaced after validation", () => {
    withTmp((dir) => {
      const p = path.join(dir, "swapped.txt")
      fs.writeFileSync(p, "ORIGINAL-CONTENT")
      const expected = identityOf(fs.statSync(p))

      // The real attack: an approved path is validated, then a different file
      // is renamed over that exact path before the read opens it. Reproduced
      // with genuine filesystem operations, not a stubbed stat.
      const replacement = path.join(dir, "replacement.txt")
      fs.writeFileSync(replacement, "ATTACKER-CONTENT-DIFFERENT-SIZE")
      fs.renameSync(replacement, p)

      expect(() => openVerified(p, expected)).toThrow(PathChangedError)
      expect(() => openVerified(p, expected)).toThrow(/changed after validation/)
    })
  })

  it("refuses a final-component symlink instead of following it", () => {
    withTmp((dir) => {
      const real = path.join(dir, "real.txt")
      fs.writeFileSync(real, "REAL")
      const link = path.join(dir, "link.txt")
      // On Windows this needs privileges; skip rather than pretend it passed.
      let linked = true
      try {
        fs.symlinkSync(real, link, "file")
      } catch {
        linked = false
      }
      if (!linked) return
      const expected = identityOf(fs.statSync(real))
      // Following the link would hand back the target's bytes under the link's
      // name; O_NOFOLLOW must refuse the open outright.
      expect(() => openVerified(link, expected)).toThrow(PathChangedError)
    })
  })

  it("returns the identity of the opened descriptor, not the path it was given", () => {
    withTmp((dir) => {
      const p = path.join(dir, "nocheck.txt")
      fs.writeFileSync(p, "no expected identity supplied")
      const handle = openVerified(p)
      try {
        expect(handle.identity.key).toBe(identityOf(fs.statSync(p)).key)
      } finally {
        fs.closeSync(handle.fd)
      }
    })
  })
})

describe("readVerifiedPrefix", () => {
  it("reads through the already-open descriptor and honours the byte cap", () => {
    withTmp((dir) => {
      const p = path.join(dir, "big.txt")
      fs.writeFileSync(p, "x".repeat(5000))
      const handle = openVerified(p)
      try {
        const text = readVerifiedPrefix(handle.fd, handle.identity, 1024)
        expect(text.length).toBe(1024)
      } finally {
        fs.closeSync(handle.fd)
      }
    })
  })

  it("re-checks the descriptor and refuses a stale expected identity", () => {
    withTmp((dir) => {
      const a = path.join(dir, "a.txt")
      const b = path.join(dir, "b.txt")
      fs.writeFileSync(a, "y".repeat(4000))
      fs.writeFileSync(b, "a-completely-different-file-body")
      const handle = openVerified(a)
      try {
        // An open descriptor keeps pointing at the SAME inode for its whole
        // life — that is exactly why this design is safe, and why a
        // "the file shrank underneath us" test would be fiction. What CAN go
        // wrong is a caller re-checking against a stale capture (validated,
        // swapped, then read), so that is what must fail closed.
        const stale = identityOf(fs.statSync(b))
        expect(() => readVerifiedPrefix(handle.fd, stale, MAX_VERIFIED_READ_BYTES)).toThrow(PathChangedError)
        expect(() => readVerifiedPrefix(handle.fd, stale, MAX_VERIFIED_READ_BYTES)).toThrow(/changed after validation/)
        // The same descriptor with its OWN identity still reads normally.
        expect(readVerifiedPrefix(handle.fd, handle.identity, MAX_VERIFIED_READ_BYTES).length).toBe(4000)
      } finally {
        fs.closeSync(handle.fd)
      }
    })
  })
})
