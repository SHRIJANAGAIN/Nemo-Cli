/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { configPath, loadConfig, warnOnRiskyCwd } from "./config.js"

/**
 * UNC guard (#58): a config path on a remote share would make
 * existsSync/readFileSync authenticate to the attacker host (NTLM hash
 * leak + multi-second stall). configPath() must refuse BEFORE any fs
 * probe — loudly, falling back to the default file.
 */

const savedConfig = process.env.NEMO_CONFIG

afterEach(() => {
  if (savedConfig === undefined) delete process.env.NEMO_CONFIG
  else process.env.NEMO_CONFIG = savedConfig
  vi.restoreAllMocks()
})

describe("configPath UNC refusal", () => {
  it("falls back to the default file with a loud warning, never the UNC path", () => {
    process.env.NEMO_CONFIG = "\\\\192.0.2.1\\share\\x.json"
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    const resolved = configPath()
    expect(resolved).not.toContain("192.0.2.1")
    expect(resolved.endsWith("config.json")).toBe(true)
    expect(errSpy).toHaveBeenCalledOnce()
    expect(String(errSpy.mock.calls[0]?.[0] ?? "")).toContain("refusing remote UNC")
  })
})

describe("risky cwd warning (#38)", () => {
  it("warns once for the filesystem root, never for an ordinary directory", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const root = path.parse(process.cwd()).root
    warnOnRiskyCwd(root)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("system location")
    warnOnRiskyCwd(root) // once per path per process — no spam
    expect(warn).toHaveBeenCalledOnce()
    warn.mockClear()
    warnOnRiskyCwd(os.tmpdir())
    expect(warn).not.toHaveBeenCalled()
  })

  it("fires through loadConfig so --cwd/NEMO_CWD cannot re-root silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const root = path.parse(process.cwd()).root
    // Fresh risky path the unit test above has not warned on: the once-per
    // process set must not swallow a genuinely new location.
    const sys = process.platform === "win32" ? path.join(root, "Windows") : "/etc"
    const cfg = loadConfig({ cwd: sys, provider: "nvidia", baseUrl: "", model: "" })
    expect(cfg.cwd).toBe(path.resolve(sys))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("system location"))
  })

  it("sees through a symlink pointing at a system location", () => {
    // A fresh risky target the earlier tests have not warned on (the
    // once-per-process set must not swallow it).
    const root = path.parse(process.cwd()).root
    const target = process.platform === "win32" ? path.join(root, "Windows", "System32") : "/etc/ssl"
    if (!fs.existsSync(target)) return // unknown layout — nothing to assert
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-cwdlink-"))
    try {
      const link = path.join(dir, "proj")
      try {
        fs.symlinkSync(target, link, "junction")
      } catch {
        return // no link privilege on this host — nothing to assert
      }
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      warnOnRiskyCwd(link)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("system location"))
      expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("resolves to")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
