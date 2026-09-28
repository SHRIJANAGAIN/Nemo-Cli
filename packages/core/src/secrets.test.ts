import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { redactSecrets, secureDir, withFileLock } from "./secrets.js"

describe("redactSecrets", () => {
  it("masks api keys", () => {
    expect(redactSecrets({ apiKey: "nvapi-1234567890abcdef" })).toEqual({ apiKey: "****" })
  })
  it("truncates long tokens", () => {
    const out = redactSecrets("sk-abcdefghijklmnopqrstuvwxyz012345") as string
    expect(out).toContain("****")
    expect(out).not.toContain("012345")
  })
  it("masks every known secret key shape, case-insensitively", () => {
    const out = redactSecrets({
      TOKEN: "abc",
      nested: { Authorization: "Bearer x", OTHER: "visible" },
    }) as Record<string, unknown>
    expect(out).toEqual({ TOKEN: "****", nested: { Authorization: "****", OTHER: "visible" } })
  })
  it("redacts inside arrays and truncates long bare strings", () => {
    const out = redactSecrets(["short", "x".repeat(40)]) as string[]
    expect(out[0]).toBe("short")
    expect(out[1]).toMatch(/^\S{4}\*\*\*\*$/)
  })
  it("passes non-secret scalars through untouched", () => {
    expect(redactSecrets(42)).toBe(42)
    expect(redactSecrets(null)).toBe(null)
    expect(redactSecrets("hello")).toBe("hello")
  })
  it("never leaks key material for provider prefixes", () => {
    for (const key of ["nvapi-123", "hf_abcdef", "xai-abcdef", "AIzaabcdef"]) {
      const out = String(redactSecrets(key))
      expect(out).not.toContain(key.slice(4))
    }
  })
})

describe("secureDir", () => {
  it("creates the dir and returns it", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-sec-")), "sub")
    expect(secureDir(dir)).toBe(dir)
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe("withFileLock", () => {
  it("runs the fn and releases the lock", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-lock-")), "s.json")
    const out = await withFileLock(file, () => 42)
    expect(out).toBe(42)
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
  })
  it("releases the lock even when fn throws", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-lock-")), "s.json")
    await expect(withFileLock(file, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    expect(fs.existsSync(`${file}.lock`)).toBe(false)
  })
})
