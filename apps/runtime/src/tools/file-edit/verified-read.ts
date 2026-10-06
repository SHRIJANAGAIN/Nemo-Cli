/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * TOCTOU-hardened reads (#121).
 *
 * A tool call takes two separate decisions: the PATH is validated against the
 * project roots and approved, and only afterwards is the file opened. Those
 * two steps are not atomic. Anything that can write the workspace in between —
 * a concurrent tool call, a file watcher, a build step, or a second process —
 * can rename a different file over the approved path, and the subsequent read
 * returns THOSE bytes while every check above it passed honestly.
 *
 * The fix is to stop treating the path as the thing that was approved:
 *
 *   1. `openVerified` opens the file ONCE, with `O_NOFOLLOW` on the final
 *      component so a symlink is refused rather than followed.
 *   2. It `fstat`s the DESCRIPTOR it actually holds and derives the identity
 *      from that — not from the path.
 *   3. When the caller supplies the identity captured at validation time, the
 *      two are compared and a mismatch fails closed.
 *   4. `readVerifiedPrefix` reads through that same descriptor, re-checking
 *      the identity first, so a swap after the open cannot shorten or swap the
 *      bytes that get returned.
 *
 * Every filesystem operation here is real: no stat/read stubs, so the tests
 * reproduce the race with genuine rename and symlink calls.
 */

import * as fs from "fs"

export const MAX_VERIFIED_READ_BYTES = 50 * 1024

/** Identity of the file a descriptor actually holds. */
export interface FileIdentity {
  /** Device id. */
  dev: number
  /** Inode / file index. Zero on platforms that do not report one. */
  ino: number
  /** Byte length at validation time. */
  size: number
  /** Modification time in ms at validation time. */
  mtimeMs: number
  /**
   * Opaque comparison key. `ino` alone is not enough: some platforms report it
   * as zero, so size and mtime participate too. A different file with a
   * different length or timestamp still produces a different key there.
   */
  key: string
}

export interface VerifiedHandle {
  fd: number
  identity: FileIdentity
}

/** The approved path no longer names the same file. Fails closed. */
export class PathChangedError extends Error {
  constructor(target: string, detail: string) {
    super(
      `Refusing to read ${target}: the file changed after validation (${detail}). Read it again to see the current contents.`,
    )
    this.name = "PathChangedError"
  }
}

/** Derive the comparison identity from an already-obtained stat. */
export function identityOf(stat: fs.Stats): FileIdentity {
  const dev = Number(stat.dev)
  const ino = Number(stat.ino)
  const size = Number(stat.size)
  const mtimeMs = Number(stat.mtimeMs)
  return { dev, ino, size, mtimeMs, key: `${dev}:${ino}:${size}:${mtimeMs}` }
}

/** First field where `a` and `b` disagree, for an honest error message. */
function firstDifference(a: FileIdentity, b: FileIdentity): string {
  if (a.dev !== b.dev) return `device ${a.dev} → ${b.dev}`
  if (a.ino !== b.ino) return `inode ${a.ino} → ${b.ino}`
  if (a.size !== b.size) return `size ${a.size} → ${b.size}`
  if (a.mtimeMs !== b.mtimeMs) return `mtime ${a.mtimeMs} → ${b.mtimeMs}`
  return "identity differs"
}

/**
 * Open `target` exactly once and report what the DESCRIPTOR is, not what the
 * path claims. When `expected` is supplied the descriptor's identity must
 * match it or the open is refused.
 *
 * `O_NOFOLLOW` applies to the final component only — that is precisely the
 * component an attacker swaps — and is a POSIX flag, so it is omitted on
 * Windows, where the identity check below is the enforcement instead.
 */
export function openVerified(target: string, expected?: FileIdentity): VerifiedHandle {
  const flags = fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0))
  let fd: number
  try {
    fd = fs.openSync(target, flags)
  } catch (error) {
    // O_NOFOLLOW turns "final component is a symlink" into ELOOP/EMFILE-ish
    // errors; surface them as the same fail-closed refusal, not as a raw errno.
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === "ELOOP") throw new PathChangedError(target, "the path is a symlink and symlinks are not followed")
    throw error
  }
  try {
    const identity = identityOf(fs.fstatSync(fd))
    if (expected && identity.key !== expected.key) {
      throw new PathChangedError(target, firstDifference(expected, identity))
    }
    return { fd, identity }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

/**
 * Read at most `maxBytes` through an already-open descriptor, re-checking the
 * identity first. Bounding the allocation is the same reason read-file caps
 * its prefix: an unbounded read of a huge file is an out-of-memory kill.
 */
export function readVerifiedPrefix(fd: number, expected: FileIdentity, maxBytes: number): string {
  const current = identityOf(fs.fstatSync(fd))
  if (current.key !== expected.key) {
    throw new PathChangedError("<open descriptor>", firstDifference(expected, current))
  }
  const buf = Buffer.alloc(maxBytes)
  const read = fs.readSync(fd, buf, 0, maxBytes, 0)
  return buf.subarray(0, Math.max(0, read)).toString("utf8")
}

/**
 * Convenience wrapper: validate-then-read in one call, closing the descriptor
 * on every path. `expected` is the identity captured during validation; omit it
 * to skip the comparison (still symlink-guarded, still bounded).
 */
export function readVerifiedFile(target: string, maxBytes: number, expected?: FileIdentity): string {
  const handle = openVerified(target, expected)
  try {
    return readVerifiedPrefix(handle.fd, handle.identity, maxBytes)
  } finally {
    fs.closeSync(handle.fd)
  }
}
