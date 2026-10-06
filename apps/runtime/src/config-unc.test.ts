/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { configPath, isRemoteUncPath } from "./config.js"

/**
 * UNC guard (#58): a config path on a remote share would make
 * existsSync/readFileSync authenticate to the attacker host (NTLM hash
 * leak + multi-second stall). configPath() must refuse BEFORE any fs
 * probe — loudly, falling back to the default file.
 */

const savedConfig = process.env.TRAYAMBAK_CONFIG

afterEach(() => {
  if (savedConfig === undefined) delete process.env.TRAYAMBAK_CONFIG
  else process.env.TRAYAMBAK_CONFIG = savedConfig
  vi.restoreAllMocks()
})

describe("isRemoteUncPath", () => {
  it("flags remote shares and lets local paths through", () => {
    expect(isRemoteUncPath("\\\\host\\share\\x.json")).toBe(true)
    expect(isRemoteUncPath("//host/share/x.json")).toBe(true)
    expect(isRemoteUncPath("\\\\?\\UNC\\host\\share")).toBe(true)
    expect(isRemoteUncPath("C:\\local\\x.json")).toBe(false)
    expect(isRemoteUncPath("./relative/x.json")).toBe(false)
    expect(isRemoteUncPath("\\\\?\\C:\\local")).toBe(false)
    expect(isRemoteUncPath("\\\\.\\PhysicalDrive0")).toBe(false)
    expect(isRemoteUncPath("")).toBe(false)
  })
})

describe("configPath UNC refusal", () => {
  it("falls back to the default file with a loud warning, never the UNC path", () => {
    process.env.TRAYAMBAK_CONFIG = "\\\\192.0.2.1\\share\\x.json"
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never)
    const resolved = configPath()
    expect(resolved).not.toContain("192.0.2.1")
    expect(resolved.endsWith("config.json")).toBe(true)
    expect(errSpy).toHaveBeenCalledOnce()
    expect(String(errSpy.mock.calls[0]?.[0] ?? "")).toContain("refusing remote UNC")
  })
})
