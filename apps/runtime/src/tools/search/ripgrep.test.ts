/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  buildSearchArgs,
  normalizeRgPath,
  parseRgJson,
  resolveRipgrep,
  runRipgrep,
  searchRipgrep,
  setRipgrepOverride,
} from "./ripgrep.js"
import { IGNORED_DIRS } from "../file-edit/fs-walk.js"

/** Real binary if the machine has one — integration cases skip without it. */
const REAL_RG = resolveRipgrep()

afterEach(() => {
  setRipgrepOverride(undefined)
})

describe("normalizeRgPath", () => {
  it("strips the ./ prefix rg prints for a search root of .", () => {
    expect(normalizeRgPath("./src/a.ts")).toBe(path.join("src", "a.ts"))
  })

  it("passes through paths without a prefix", () => {
    expect(normalizeRgPath("src/a.ts")).toBe(path.join("src", "a.ts"))
  })

  it.skipIf(process.platform !== "win32")("handles native windows-style output", () => {
    expect(normalizeRgPath(".\\src\\a.ts")).toBe(path.join("src", "a.ts"))
  })
})

describe("buildSearchArgs", () => {
  it("always carries the safety flags and targets the cwd", () => {
    const args = buildSearchArgs({ cwd: "/x", pattern: "foo" })
    expect(args).toContain("--no-config")
    expect(args).toContain("--no-messages")
    expect(args).toContain("--hidden")
    expect(args).toContain("--json")
    expect(args[args.length - 1]).toBe(".")
  })

  it("applies every IGNORED_DIRS exclusion so both backends agree", () => {
    const args = buildSearchArgs({ cwd: "/x", pattern: "foo" })
    for (const dir of IGNORED_DIRS) {
      expect(args).toContain("--glob")
      expect(args).toContain(`!${dir}`)
    }
  })

  it("passes the pattern after -e so flag-looking patterns stay patterns", () => {
    const args = buildSearchArgs({ cwd: "/x", pattern: "--rm -rf" })
    const eIdx = args.indexOf("-e")
    expect(eIdx).toBeGreaterThan(-1)
    expect(args[eIdx + 1]).toBe("--rm -rf")
  })

  it("maps every option to its flag", () => {
    const args = buildSearchArgs({
      cwd: "/x",
      pattern: "pat",
      fixedStrings: true,
      ignoreCase: true,
      contextLines: 3,
      glob: "*.ts",
    })
    expect(args).toContain("--fixed-strings")
    expect(args).toContain("-i")
    expect(args).toContain("-C")
    expect(args).toContain("3")
    expect(args[args.indexOf("-g") + 1]).toBe("*.ts")
  })

  it("skips context and include flags when unset or wildcard", () => {
    const args = buildSearchArgs({ cwd: "/x", pattern: "pat", glob: "*", contextLines: 0 })
    expect(args).not.toContain("-C")
    expect(args).not.toContain("-g")
  })

  it("uses plain --files listing (no --json) in filesOnly mode", () => {
    const args = buildSearchArgs({ cwd: "/x", filesOnly: true, glob: "*.ts" })
    expect(args).toContain("--files")
    expect(args).not.toContain("--json")
    expect(args).not.toContain("-e")
  })
})

describe("parseRgJson", () => {
  const matchEvent = (pathText: string, line: number, text: string): string =>
    JSON.stringify({
      type: "match",
      data: { path: { text: pathText }, line_number: line, lines: { text } },
    })

  it("extracts matches with normalized paths and trimmed newlines", () => {
    const hits = parseRgJson([matchEvent("./src/a.ts", 7, "const x = 1\n"), ""].join("\n"))
    expect(hits).toEqual([{ path: path.join("src", "a.ts"), line: 7, text: "const x = 1", isMatch: true }])
  })

  it("marks context events as non-match hits", () => {
    const line = JSON.stringify({
      type: "context",
      data: { path: { text: "b.ts" }, line_number: 2, lines: { text: "ctx\n" } },
    })
    const hits = parseRgJson(line)
    expect(hits).toHaveLength(1)
    expect(hits[0].isMatch).toBe(false)
    expect(hits[0].line).toBe(2)
  })

  it("ignores begin/end/summary and malformed lines", () => {
    const input = [
      JSON.stringify({ type: "begin", data: { path: { text: "a.ts" } } }),
      "{truncated json",
      JSON.stringify({ type: "summary", data: { stats: {} } }),
      matchEvent("a.ts", 1, "ok\n"),
      "",
    ].join("\n")
    const hits = parseRgJson(input)
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toBe("ok")
  })

  it("skips events without a line number", () => {
    const line = JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, lines: { text: "x" } } })
    expect(parseRgJson(line)).toHaveLength(0)
  })

  it("decodes base64 bytes fields for non-UTF8 paths", () => {
    const b64 = Buffer.from(path.join("src", "bin.ts"), "utf8").toString("base64")
    const line = JSON.stringify({
      type: "match",
      data: { path: { bytes: b64 }, line_number: 3, lines: { text: "hit\n" } },
    })
    const hits = parseRgJson(line)
    expect(hits[0].path).toBe(path.join("src", "bin.ts"))
  })

  it("strips CRLF line endings from hit text", () => {
    const hits = parseRgJson(matchEvent("a.ts", 1, "windows line\r\n"))
    expect(hits[0].text).toBe("windows line")
  })
})

describe("backend selection", () => {
  it("honours an explicit binary override", () => {
    setRipgrepOverride("C:\\tools\\rg.exe")
    expect(resolveRipgrep()).toBe("C:\\tools\\rg.exe")
  })

  it("honours a null override (forced Node fallback)", () => {
    setRipgrepOverride(null)
    expect(resolveRipgrep()).toBeNull()
  })

  it("auto-detection is stable across calls", () => {
    setRipgrepOverride(undefined)
    const first = resolveRipgrep()
    expect(resolveRipgrep()).toBe(first)
    if (first !== null) expect(fs.statSync(first).isFile()).toBe(true)
  })
})

describe("searchRipgrep outcomes", () => {
  it("fails cleanly when the backend is disabled", async () => {
    setRipgrepOverride(null)
    const out = await searchRipgrep({ cwd: os.tmpdir(), pattern: "x" })
    expect(out.kind).toBe("failed")
  })

  it("fails cleanly when the binary does not exist", async () => {
    setRipgrepOverride(path.join(os.tmpdir(), "no-such-rg-binary.exe"))
    const out = await searchRipgrep({ cwd: os.tmpdir(), pattern: "x" })
    expect(out.kind).toBe("failed")
    if (out.kind === "failed") expect(out.reason).toContain("spawn failed")
  })
})

describe("runRipgrep mechanics (no rg binary required)", () => {
  it("kills a process that exceeds the timeout", async () => {
    const res = await runRipgrep(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      cwd: os.tmpdir(),
      timeoutMs: 300,
    })
    expect(res.timedOut).toBe(true)
    expect(res.spawnError).toBeNull()
  }, 15000)

  it("caps stdout at maxBytes and kills the producer", async () => {
    const res = await runRipgrep(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024 * 1024))"], {
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxBytes: 1024,
    })
    expect(res.bytesTruncated).toBe(true)
    expect(Buffer.byteLength(res.stdout)).toBeLessThanOrEqual(1024)
  }, 15000)

  it("reports spawn failures instead of throwing", async () => {
    const res = await runRipgrep(path.join(os.tmpdir(), "missing-rg.exe"), [], { cwd: os.tmpdir() })
    expect(res.spawnError).not.toBeNull()
    expect(res.exitCode).toBeNull()
  })
})

describe.skipIf(REAL_RG === null)("searchRipgrep against a real binary", () => {
  const makeFixture = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-rg-"))
    fs.mkdirSync(path.join(dir, "src"), { recursive: true })
    fs.mkdirSync(path.join(dir, "node_modules", "junk"), { recursive: true })
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true })
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "const alpha = 1\nexport beta\n")
    fs.writeFileSync(path.join(dir, "node_modules", "junk", "x.ts"), "alpha junk\n")
    fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "alpha workflow\n")
    fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n")
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
    fs.writeFileSync(path.join(dir, "dist", "out.js"), "alpha dist\n")
    return dir
  }

  it("finds matches, includes hidden files, skips ignored dirs and gitignored output", async () => {
    const dir = makeFixture()
    try {
      const out = await searchRipgrep({ cwd: dir, pattern: "alpha" })
      expect(out.kind).toBe("ok")
      if (out.kind !== "ok") return
      const paths = out.hits.filter((h) => h.isMatch).map((h) => h.path)
      expect(paths).toContain(path.join("src", "a.ts"))
      expect(paths).toContain(path.join(".github", "workflows", "ci.yml"))
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false)
      expect(paths.some((p) => p.startsWith(`dist${path.sep}`))).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts JS look-around patterns through the PCRE2 retry", async () => {
    const dir = makeFixture()
    try {
      const out = await searchRipgrep({ cwd: dir, pattern: "alpha(?=zzz-never)" })
      expect(out.kind).toBe("ok")
      if (out.kind === "ok") expect(out.hits).toHaveLength(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lists files in filesOnly mode with platform paths", async () => {
    const dir = makeFixture()
    try {
      const out = await searchRipgrep({ cwd: dir, filesOnly: true, glob: "*.ts" })
      expect(out.kind).toBe("ok")
      if (out.kind !== "ok") return
      const paths = out.hits.map((h) => h.path)
      expect(paths).toContain(path.join("src", "a.ts"))
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false)
      expect(paths.every((p) => !p.startsWith("./"))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
