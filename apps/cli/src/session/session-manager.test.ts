import { describe, expect, it, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { SessionManager } from "./session-manager.js"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-sessions-"))
  process.env.NEMO_SESSIONS_FILE = path.join(dir, "sessions.json")
})

describe("SessionManager persistence", () => {
  it("creates unique ids", () => {
    const m = new SessionManager()
    const a = m.create("a")
    const b = m.create("b")
    expect(a.id).not.toBe(b.id)
  })

  it("forks with the requested name and persists across instances", () => {
    const m = new SessionManager()
    const parent = m.create("parent")
    const child = m.fork(parent.id, "child-name")
    expect(child?.name).toBe("child-name")
    const m2 = new SessionManager()
    expect(m2.get(parent.id)?.name).toBe("parent")
    expect(m2.get(child!.id)?.name).toBe("child-name")
  })

  it("update never rewrites id/createdAt", () => {
    const m = new SessionManager()
    const s = m.create("s")
    const updated = m.update(s.id, { name: "renamed" })
    expect(updated?.id).toBe(s.id)
    expect(updated?.createdAt.getTime()).toBe(s.createdAt.getTime())
  })
})
