/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * `Session.save` / `Session.load` are the `--session <path>` surface: whatever
 * the user points at is read back and replayed into the agent loop, and whatever
 * the session contains is written there. Three weaknesses:
 *
 *  - `save` wrote in place with `writeFileSync`. A crash mid-write left a
 *    truncated file; `load` then could not parse it, reported "no session", and
 *    the next `save` overwrote it — total transcript loss, silently. It also used
 *    the umask default (0644 on POSIX) even though the file holds the user's
 *    prompts and full tool output; every sibling store (`transcript.ts`,
 *    `session-manager.ts`) writes 0600.
 *  - `load` did `push(...(payload.messages ?? []))` on unvalidated JSON. A string
 *    spread into one message per CHARACTER; a non-iterable object threw, and the
 *    catch turned that into "no session" — the whole transcript discarded.
 *  - `load` read the file with no size bound.
 *
 * Node's builtin module namespaces are frozen, so these assert against `vi.mock`
 * wrappers rather than `vi.spyOn`. The wrappers call through, so behaviour is
 * unchanged for everything else in the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return {
    ...actual,
    default: actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    readFileSync: vi.fn(actual.readFileSync),
  }
})

// `vi.mock` is hoisted above this import by the vitest transform, so a plain
// static import already sees the mocked `fs`.
import { Session } from "./session.js"

const renameSync = fs.renameSync as unknown as ReturnType<typeof vi.fn>
const writeFileSync = fs.writeFileSync as unknown as ReturnType<typeof vi.fn>
const readFileSync = fs.readFileSync as unknown as ReturnType<typeof vi.fn>

const dirs: string[] = []

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-rt-"))
  dirs.push(dir)
  return dir
}

function write(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body, "utf8")
  return file
}

beforeEach(() => {
  renameSync.mockClear()
  writeFileSync.mockClear()
  readFileSync.mockClear()
})

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (!dir) break
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

describe("Session.save publishes by rename", () => {
  it("swaps the destination in atomically instead of truncating in place", () => {
    const dir = workspace()
    const file = path.join(dir, "nested", "s.json")
    const s = new Session()
    s.add({ role: "user", content: "hello" })
    s.save(file)

    // A plain writeFileSync would leave renameSync uncalled and would truncate
    // any existing session first — which is what lost transcripts when the
    // process died mid-write.
    expect(renameSync).toHaveBeenCalledTimes(1)
    const [from, to] = renameSync.mock.calls[0] as [string, string]
    expect(to).toBe(file)
    expect(from).not.toBe(file)
    expect(from.includes(".tmp")).toBe(true)
    // The destination is never opened for writing directly.
    const destinations = writeFileSync.mock.calls.map((c) => String(c[0]))
    expect(destinations).not.toContain(file)
    expect(fs.existsSync(from)).toBe(false)
    expect(Session.load(file)?.messages).toHaveLength(1)
  })

  it("writes the body at 0600 rather than leaving the umask default", () => {
    const dir = workspace()
    const file = path.join(dir, "s.json")
    const s = new Session()
    s.add({ role: "user", content: "hello" })
    s.save(file)
    const opts = writeFileSync.mock.calls[0]?.[2] as { mode?: number } | undefined
    expect(opts?.mode).toBe(0o600)
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it("cleans up the temp file when the save fails", () => {
    const dir = workspace()
    const file = path.join(dir, "s.json")
    const good = new Session()
    good.add({ role: "user", content: "original transcript" })
    good.save(file)
    renameSync.mockClear()

    // A directory at the destination makes the rename fail.
    const blocked = path.join(dir, "blocked")
    fs.mkdirSync(blocked)
    const s = new Session()
    s.add({ role: "user", content: "new" })
    expect(() => s.save(blocked)).toThrow()

    // The temp file must not be left behind for the next run to trip over.
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"))
    expect(leftovers).toEqual([])
    // The real session survives intact.
    expect(Session.load(file)?.messages).toHaveLength(1)
  })

  it("round-trips through save and load", () => {
    const dir = workspace()
    const file = path.join(dir, "s.json")
    const s = new Session()
    s.add({ role: "user", content: "one" })
    s.add({ role: "assistant", content: [{ type: "text", text: "two" }], stopReason: "end_turn" })
    s.save(file)
    expect(Session.load(file)?.messages).toHaveLength(2)
  })
})

describe("Session.load validates what it restores", () => {
  it("drops entries that are not messages instead of spreading them", () => {
    const dir = workspace()
    // A bare string used to become one message per character.
    const asString = write(dir, "str.json", JSON.stringify({ messages: "abc" }))
    expect(Session.load(asString)?.messages).toEqual([])

    const mixed = write(
      dir,
      "mixed.json",
      JSON.stringify({
        messages: [
          { role: "user", content: "keep me" },
          "not an object",
          null,
          42,
          { role: "wizard", content: "bad role" },
          { content: "no role at all" },
          { role: "assistant", content: [{ type: "text", text: "keep me too" }] },
        ],
      }),
    )
    const restored = Session.load(mixed)
    expect(restored?.messages).toHaveLength(2)
    expect(restored?.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("returns a usable session instead of discarding everything on a bad shape", () => {
    const dir = workspace()
    // `{}` used to throw on spread; the catch reported "no session".
    const notArray = write(dir, "obj.json", JSON.stringify({ messages: { role: "user" } }))
    const s = Session.load(notArray)
    expect(s).not.toBeNull()
    expect(s?.messages).toEqual([])

    const missing = write(dir, "none.json", JSON.stringify({}))
    expect(Session.load(missing)?.messages).toEqual([])
  })

  it("still returns null for genuinely unusable input", () => {
    const dir = workspace()
    expect(Session.load(write(dir, "bad.json", "{not json"))).toBeNull()
    expect(Session.load(path.join(dir, "absent.json"))).toBeNull()
  })

  it("refuses a file past the size cap without reading it", () => {
    const dir = workspace()
    const file = path.join(dir, "huge.json")
    // A sparse file: `statSync().size` reports past the cap while costing no
    // disk and no memory, so the guard needs no 512MB fixture.
    fs.writeFileSync(file, "{}", "utf8")
    fs.truncateSync(file, 513 * 1024 * 1024)
    expect(fs.statSync(file).size).toBeGreaterThan(512 * 1024 * 1024)

    readFileSync.mockClear()
    expect(Session.load(file)).toBeNull()
    // Rejected on the stat, before the contents are pulled into memory.
    expect(readFileSync).not.toHaveBeenCalled()
    fs.rmSync(file, { force: true })
  })
})
