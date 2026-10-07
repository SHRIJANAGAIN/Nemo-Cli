/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import * as fs from "fs"
import { spawnSync } from "child_process"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { assertMutablePath, resolveConstrainedPath, truncateOutput } from "./types.js"
import type { TrayambakConfig } from "../config.js"

const home = os.homedir()
const outsideRoot = path.join(path.parse(home).root, "outside-root-xyz")

describe("resolveConstrainedPath workspace containment", () => {
  it("accepts relative paths inside the workspace", () => {
    const cwd = path.join(os.tmpdir(), "ws-proj")
    expect(resolveConstrainedPath("src/index.ts", cwd)).toBe(path.join(cwd, "src", "index.ts"))
    expect(resolveConstrainedPath(".", cwd)).toBe(cwd)
  })

  it("expands ~ against the home directory", () => {
    const cwd = path.join(os.tmpdir(), "ws-proj")
    expect(resolveConstrainedPath("~/notes.txt", cwd)).toBe(path.join(home, "notes.txt"))
    expect(resolveConstrainedPath("~", cwd)).toBe(home)
  })

  it("rejects a sibling directory sharing the workspace path prefix", () => {
    // Regression: the containment check used a bare startsWith, so
    // `<root>/ws-prefix-xyz-other` counted as inside `<root>/ws-prefix-xyz`.
    const cwd = path.join(path.parse(home).root, "ws-prefix-xyz")
    expect(() => resolveConstrainedPath("../ws-prefix-xyz-other/f.txt", cwd)).toThrow(/escapes/)
  })

  it("rejects absolute paths outside the workspace and home", () => {
    const cwd = path.join(os.tmpdir(), "ws-proj")
    expect(() => resolveConstrainedPath(outsideRoot, cwd)).toThrow(/escapes/)
  })
})

/**
 * A junction/symlink planted INSIDE an allowed root defeats every lexical
 * containment check: `<proj>/link/secret.txt` is textually inside the project
 * while the bytes come from somewhere else. Windows junctions need no special
 * privilege, so this is reachable by any local process. These tests build a
 * real reparse point and require the realpath pass to catch it.
 */
describe("resolveConstrainedPath reparse-point containment", () => {
  const made: string[] = []

  afterEach(() => {
    for (const dir of made.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  })

  /** A directory reachable neither from the workspace nor from $HOME. */
  function outsideDir(): string {
    const dir = fs.mkdtempSync(path.join(path.parse(home).root, "junction-outside-"))
    made.push(dir)
    return dir
  }

  function makeJunction(link: string, target: string): boolean {
    if (process.platform === "win32") {
      const r = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "ignore", timeout: 30_000 })
      return r.status === 0
    }
    try {
      fs.symlinkSync(target, link, "dir")
      return true
    } catch {
      return false
    }
  }

  it("refuses a file reached through a junction that leaves the allowed roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "junction-proj-"))
    made.push(root)
    const outside = outsideDir()
    fs.writeFileSync(path.join(outside, "secret.txt"), "top secret", "utf8")

    const link = path.join(root, "link")
    if (!makeJunction(link, outside)) return // no reparse points available here
    if (!fs.existsSync(link)) return

    // Lexically this is inside the workspace...
    expect(path.resolve(root, "link", "secret.txt").startsWith(path.resolve(root))).toBe(true)
    // ...and the realpath pass must still refuse it.
    expect(() => resolveConstrainedPath(path.join("link", "secret.txt"), root)).toThrow(/escapes/)
  }, 30_000)

  it("keeps a junction that stays inside the workspace usable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "junction-inside-"))
    made.push(root)
    const inner = path.join(root, "inner")
    fs.mkdirSync(inner, { recursive: true })

    const link = path.join(root, "link")
    if (!makeJunction(link, inner)) return
    if (!fs.existsSync(link)) return

    // Over-blocking here would lock legitimate in-tree links out.
    expect(resolveConstrainedPath(path.join("link", "file.txt"), root)).toBe(path.join(link, "file.txt"))
  }, 30_000)

  it("does not let a link become a way around the credential deny list", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "junction-creds-"))
    made.push(root)

    const link = path.join(root, "keys")
    if (!makeJunction(link, path.join(home, ".ssh"))) return
    if (!fs.existsSync(link)) return

    expect(() => resolveConstrainedPath(path.join("keys", "id_rsa"), root)).toThrow()
  }, 30_000)
})

describe("resolveConstrainedPath credential protection", () => {
  const cwd = path.join(os.tmpdir(), "ws-proj")

  it("rejects credential stores under home", () => {
    expect(() => resolveConstrainedPath(path.join(home, ".ssh", "id_rsa"), cwd)).toThrow(/protected/)
    expect(() => resolveConstrainedPath(path.join(home, ".aws", "credentials"), cwd)).toThrow(/protected/)
    expect(() => resolveConstrainedPath(path.join(home, ".ssh"), cwd)).toThrow(/protected/)
  })

  it("rejects credential stores case-insensitively", () => {
    expect(() => resolveConstrainedPath(path.join(home, ".SSH", "id_rsa"), cwd)).toThrow(/protected/)
    expect(() => resolveConstrainedPath(path.join(home, ".Git-credentials"), cwd)).toThrow(/protected/)
  })

  it("only blocks exact directory boundaries", () => {
    // `.sshkeys` merely shares a prefix with `.ssh`; over-matching here would
    // lock legitimate sibling directories out of the home allowance.
    expect(() => resolveConstrainedPath(path.join(home, ".sshkeys", "note.txt"), cwd)).not.toThrow()
    expect(() => resolveConstrainedPath(path.join(home, ".awsome", "note.txt"), cwd)).not.toThrow()
  })

  it("blocks the agent's own token but keeps agent state reachable", () => {
    expect(() => resolveConstrainedPath(path.join(home, ".trayambak", "credentials.json"), cwd)).toThrow(/protected/)
    // Global skills load from ~/.trayambak/skills and must keep working.
    expect(() => resolveConstrainedPath(path.join(home, ".trayambak", "skills", "demo"), cwd)).not.toThrow()
  })

  it("leaves ordinary home files readable", () => {
    expect(resolveConstrainedPath(path.join(home, "README.md"), cwd)).toBe(path.join(home, "README.md"))
  })

  it("keeps protected metadata readable (the write gate lives on the write path)", () => {
    expect(resolveConstrainedPath(path.join(cwd, ".git", "config"), cwd)).toBe(path.join(cwd, ".git", "config"))
    expect(() => resolveConstrainedPath(path.join(cwd, ".trayambak", "config.json"), cwd)).not.toThrow()
  })
})

describe("assertMutablePath protected metadata", () => {
  it("denies .git and .trayambak segments anywhere in the path", () => {
    expect(() => assertMutablePath("/w/.git/config")).toThrow(/protected metadata/)
    expect(() => assertMutablePath("/w/src/.git/hooks/pre-commit")).toThrow(/protected metadata/)
    expect(() => assertMutablePath("/w/.trayambak/session.json")).toThrow(/protected metadata/)
    expect(() => assertMutablePath("C:\\w\\.trayambak\\plans\\p.json")).toThrow(/protected metadata/)
  })

  it("denies case-variant spellings of the metadata names", () => {
    expect(() => assertMutablePath("/w/.GIT/config")).toThrow(/protected metadata/)
    expect(() => assertMutablePath("/w/.Trayambak/x")).toThrow(/protected metadata/)
  })

  it("keeps segment look-alikes writable", () => {
    // Segment-exact matching: prefix/extension cousins are ordinary files.
    expect(() => assertMutablePath("/w/.github/workflows/ci.yml")).not.toThrow()
    expect(() => assertMutablePath("/w/.gitkeep")).not.toThrow()
    expect(() => assertMutablePath("/w/src/.gitignore")).not.toThrow()
    expect(() => assertMutablePath("/w/.trayambakignore")).not.toThrow()
    expect(() => assertMutablePath("/w/src/index.ts")).not.toThrow()
  })

  it("still blocks direct agent-manager.json state edits", () => {
    expect(() => assertMutablePath("/w/.kilo/agent-manager.json")).toThrow(/agent_manager/)
  })

  it("blocks agent-manager.json under ANY case of the legacy dir", () => {
    // The metadata layers fold case so `.GIT` cannot ride through on a
    // case-sensitive host; the legacy guard must fold the same way.
    expect(() => assertMutablePath("/w/.KILO/agent-manager.json")).toThrow(/agent_manager/)
    expect(() => assertMutablePath("/w/.Kilo/agent-manager.json")).toThrow(/agent_manager/)
    expect(() => assertMutablePath("/w/.skt ai labs/agent-manager.json")).toThrow(/agent_manager/)
  })
})

describe("truncateOutput byte budget", () => {
  const config = { maxOutputLines: 5, maxOutputBytes: 16 } as unknown as TrayambakConfig

  it("keeps the tail preview within the BYTE budget, not just the unit budget", () => {
    // Ten lines of "α" (2 bytes per code unit): the whole text exceeds both
    // limits, so the preview is trimmed. Slicing by code units kept the last
    // 16 UNITS of a 2-bytes-per-unit string = 32 bytes — a preview that still
    // violated the budget the message promises.
    const text = Array.from({ length: 10 }, () => "α".repeat(10)).join("\n")
    const out = truncateOutput(text, config)
    expect(out.truncated).toBe(true)
    const preview = out.text.split("\n\n[output truncated")[0] ?? ""
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(config.maxOutputBytes)
  })

  it("never splits a surrogate pair in the tail preview", () => {
    // '😀' is one code point, two UTF-16 units, four UTF-8 bytes. A unit slice
    // could cut between the pair; a code-point walk cannot.
    const text = `${"x".repeat(100)}${"😀".repeat(50)}`
    const out = truncateOutput(text, config)
    const preview = out.text.split("\n\n[output truncated")[0] ?? ""
    // A lone '\uD83D' (half of '😀') must be absent: every high surrogate that
    // appears is paired, i.e. `includes("\uD83D")` is true IFF the full emoji
    // is present.
    expect(preview.includes("\uD83D")).toBe(preview.includes("😀"))
  })

  it("passes short output through untouched", () => {
    const out = truncateOutput("hi", config)
    expect(out.truncated).toBe(false)
    expect(out.text).toBe("hi")
  })

  it("truncates oversize output to the file + preview path", () => {
    const out = truncateOutput("α".repeat(64), config)
    expect(out.truncated).toBe(true)
    expect(out.text).toContain("[output truncated")
  })
})
