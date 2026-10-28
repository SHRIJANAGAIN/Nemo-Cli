/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  forgetPersistedVerdict,
  persistNegativeVerdict,
  probeKey,
  readPersistedVerdict,
} from "./shell-probe-cache.js"

const CACHE_ENV = "NEMO_SHELL_PROBE_CACHE"
const RESET_ENV = "NEMO_SHELL_PROBE_RESET"

describe("persisted shell-probe verdicts", () => {
  let dir = ""
  let cacheFile = ""
  let shellBin = ""
  const saved = { cache: process.env[CACHE_ENV], reset: process.env[RESET_ENV] }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-probecache-"))
    cacheFile = path.join(dir, "shell-probe.json")
    shellBin = path.join(dir, "bash.exe")
    fs.writeFileSync(shellBin, "binary", "utf8")
    process.env[CACHE_ENV] = cacheFile
    delete process.env[RESET_ENV]
  })

  afterEach(() => {
    if (saved.cache === undefined) delete process.env[CACHE_ENV]
    else process.env[CACHE_ENV] = saved.cache
    if (saved.reset === undefined) delete process.env[RESET_ENV]
    else process.env[RESET_ENV] = saved.reset
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("remembers a negative verdict and hands it back", () => {
    const key = probeKey(shellBin, ["-c"])
    persistNegativeVerdict(key, shellBin, "shell cannot run under windows-restricted isolation")
    expect(readPersistedVerdict(key, shellBin)).toEqual({
      ok: false,
      reason: "shell cannot run under windows-restricted isolation",
    })
  })

  it("returns nothing for a shell chain it has never seen", () => {
    expect(readPersistedVerdict(probeKey(shellBin, ["-z"]), shellBin)).toBeUndefined()
  })

  it("re-probes when the shell binary changed", () => {
    const key = probeKey(shellBin, ["-c"])
    persistNegativeVerdict(key, shellBin, "old")
    // A Git Bash upgrade rewrites the binary: the old verdict described a
    // shell that no longer exists.
    fs.writeFileSync(shellBin, "a different, longer binary", "utf8")
    expect(readPersistedVerdict(key, shellBin)).toBeUndefined()
  })

  it("re-probes when the runtime changed", () => {
    const key = probeKey(shellBin, ["-c"])
    persistNegativeVerdict(key, shellBin, "old")
    const original = Object.getOwnPropertyDescriptor(process, "version")
    Object.defineProperty(process, "version", { value: "v0.0.0-impostor", configurable: true })
    try {
      expect(readPersistedVerdict(key, shellBin)).toBeUndefined()
    } finally {
      if (original) Object.defineProperty(process, "version", original)
    }
  })

  it("re-probes when the verdict expired", () => {
    const key = probeKey(shellBin, ["-c"])
    persistNegativeVerdict(key, shellBin, "old")
    const store = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, { expiresAt: number }>
    store[key].expiresAt = Date.now() - 1
    fs.writeFileSync(cacheFile, JSON.stringify(store), "utf8")
    expect(readPersistedVerdict(key, shellBin)).toBeUndefined()
  })

  it("ignores the cache when a reset is requested", () => {
    const key = probeKey(shellBin, ["-c"])
    persistNegativeVerdict(key, shellBin, "old")
    process.env[RESET_ENV] = "1"
    expect(readPersistedVerdict(key, shellBin)).toBeUndefined()
  })

  it("forgets a verdict once the shell proves it can run", () => {
    const key = probeKey(shellBin, ["-c"])
    persistNegativeVerdict(key, shellBin, "old")
    forgetPersistedVerdict(key)
    expect(readPersistedVerdict(key, shellBin)).toBeUndefined()
  })

  it("survives a corrupt cache file", () => {
    fs.writeFileSync(cacheFile, "{not json", "utf8")
    expect(readPersistedVerdict(probeKey(shellBin, ["-c"]), shellBin)).toBeUndefined()
    // And a corrupt file does not block a fresh write.
    persistNegativeVerdict(probeKey(shellBin, ["-c"]), shellBin, "fresh")
    expect(readPersistedVerdict(probeKey(shellBin, ["-c"]), shellBin)?.reason).toBe("fresh")
  })

  it("writes nothing when there is no verdict to remember", () => {
    forgetPersistedVerdict(probeKey(shellBin, ["-c"]))
    expect(fs.existsSync(cacheFile)).toBe(false)
  })
})
