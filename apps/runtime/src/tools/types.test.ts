/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { assertMutablePath, resolveConstrainedPath } from "./types.js"

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
})
