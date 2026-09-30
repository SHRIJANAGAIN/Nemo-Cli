/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { archiveSession, deleteSession, unarchiveSession } from "./archive.js"

/**
 * archive/unarchive/delete operate on sessionsRoot()/sessionDir(id), and
 * sessionsRoot() honors TRAYAMBAK_SESSIONS_DIR — so every case runs against a
 * throwaway directory and the user's ~/.trayambak/sessions is never touched.
 */

let sessionsDir = ""
let savedEnv: string | undefined

function sessionPath(id: string): string {
  return path.join(sessionsDir, id)
}

function archivedPath(id: string): string {
  return path.join(sessionsDir, ".archived", id)
}

function makeSession(id: string, marker = "hello"): void {
  const dir = sessionPath(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "context.jsonl"), marker, "utf8")
}

beforeEach(() => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-sessions-"))
  savedEnv = process.env.TRAYAMBAK_SESSIONS_DIR
  process.env.TRAYAMBAK_SESSIONS_DIR = sessionsDir
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.TRAYAMBAK_SESSIONS_DIR
  else process.env.TRAYAMBAK_SESSIONS_DIR = savedEnv
  try {
    fs.rmSync(sessionsDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("archiveSession", () => {
  it("moves a live session directory under .archived", () => {
    makeSession("s-1", "payload")
    expect(archiveSession("s-1")).toBe("archived s-1")

    expect(fs.existsSync(sessionPath("s-1"))).toBe(false)
    expect(fs.existsSync(path.join(archivedPath("s-1"), "context.jsonl"))).toBe(true)
    expect(fs.readFileSync(path.join(archivedPath("s-1"), "context.jsonl"), "utf8")).toBe("payload")
  })

  it("reports a missing session instead of throwing", () => {
    expect(archiveSession("nope")).toBe("session not found: nope")
    expect(fs.existsSync(archivedPath("nope"))).toBe(false)
  })

  it("creates the .archived parent on demand", () => {
    makeSession("s-2")
    expect(fs.existsSync(path.join(sessionsDir, ".archived"))).toBe(false)
    archiveSession("s-2")
    expect(fs.existsSync(archivedPath("s-2"))).toBe(true)
  })
})

describe("unarchiveSession", () => {
  it("restores an archived session back to the live directory", () => {
    makeSession("s-3", "kept")
    archiveSession("s-3")

    expect(unarchiveSession("s-3")).toBe("unarchived s-3")
    expect(fs.existsSync(archivedPath("s-3"))).toBe(false)
    expect(fs.readFileSync(path.join(sessionPath("s-3"), "context.jsonl"), "utf8")).toBe("kept")
  })

  it("reports an archived session that does not exist", () => {
    expect(unarchiveSession("ghost")).toBe("archived session not found: ghost")
  })
})

describe("deleteSession", () => {
  it("removes a live session directory", () => {
    makeSession("s-4")
    expect(deleteSession("s-4")).toBe("deleted s-4")
    expect(fs.existsSync(sessionPath("s-4"))).toBe(false)
  })

  it("removes an archived session directory", () => {
    makeSession("s-5")
    archiveSession("s-5")
    expect(deleteSession("s-5")).toBe("deleted s-5")
    expect(fs.existsSync(archivedPath("s-5"))).toBe(false)
  })

  it("is idempotent for a session that exists in neither place", () => {
    expect(deleteSession("never-existed")).toBe("deleted never-existed")
    expect(fs.existsSync(sessionPath("never-existed"))).toBe(false)
  })

  it("leaves sibling sessions untouched", () => {
    makeSession("keep-me")
    makeSession("delete-me")
    deleteSession("delete-me")
    expect(fs.existsSync(sessionPath("keep-me"))).toBe(true)
  })
})
