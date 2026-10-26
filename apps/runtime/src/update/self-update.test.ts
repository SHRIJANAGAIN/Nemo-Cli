/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { autoUpdateMarker, autoUpdateSelf, AUTO_UPDATE_INTERVAL_MS } from "./self-update.js"
import { getInstalledVersion } from "./auto-update.js"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nemo-self-update-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

const noopFetch = (): Promise<string | undefined> => Promise.resolve(undefined)

describe("autoUpdateSelf policy", () => {
  it("respects autoupdate:false without touching the network", async () => {
    const fetchLatest = vi.fn(noopFetch)
    const text = await autoUpdateSelf({
      home,
      config: { autoupdate: false },
      deps: { method: "npm", fetchLatest },
    })
    expect(text).toContain("autoupdate disabled")
    expect(fetchLatest).not.toHaveBeenCalled()
  })

  it("respects autoupdate:notify", async () => {
    const text = await autoUpdateSelf({ home, config: { autoupdate: "notify" }, deps: { method: "npm" } })
    expect(text).toContain("notify")
  })

  it("respects the environment kill switch", async () => {
    const fetchLatest = vi.fn(noopFetch)
    const text = await autoUpdateSelf({
      home,
      env: { NEMO_DISABLE_AUTOUPDATE: "1" },
      config: { autoupdate: true },
      deps: { method: "npm", fetchLatest },
    })
    expect(text).toContain("kill switch")
    expect(fetchLatest).not.toHaveBeenCalled()
  })

  it("tries at most once per interval", async () => {
    const at = Date.now()
    const fetchLatest = vi.fn(noopFetch)
    const first = await autoUpdateSelf({
      home,
      now: at,
      config: { autoupdate: true },
      deps: { method: "npm", fetchLatest },
    })
    expect(first).not.toContain("checked recently")
    expect(existsSync(autoUpdateMarker(home))).toBe(true)

    const second = await autoUpdateSelf({
      home,
      now: at + AUTO_UPDATE_INTERVAL_MS - 1,
      config: { autoupdate: true },
      deps: { method: "npm", fetchLatest },
    })
    expect(second).toContain("checked recently")

    const third = await autoUpdateSelf({
      home,
      now: at + AUTO_UPDATE_INTERVAL_MS + 1,
      config: { autoupdate: true },
      deps: { method: "npm", fetchLatest },
    })
    expect(third).not.toContain("checked recently")
  })

  it("reports up-to-date when the registry offers the installed version", async () => {
    const current = getInstalledVersion()
    expect(current).toBeTruthy()
    const text = await autoUpdateSelf({
      home,
      config: { autoupdate: true },
      deps: { method: "npm", fetchLatest: () => Promise.resolve(current) },
    })
    expect(text).toBe("update: already up to date")
  })

  it("never throws, even when the fetch seam rejects", async () => {
    const text = await autoUpdateSelf({
      home,
      config: { autoupdate: true },
      deps: {
        method: "npm",
        fetchLatest: () => {
          throw new Error("registry down")
        },
      },
    })
    expect(text).toMatch(/^update: /)
  })
})
