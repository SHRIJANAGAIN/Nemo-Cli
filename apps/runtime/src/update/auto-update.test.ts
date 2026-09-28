/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import {
  checkForUpdate,
  detectMethod,
  fetchLatestNpmVersion,
  findInstallRoot,
  getInstalledVersion,
  getReleaseType,
  parseMaxTagVersion,
  parseVersion,
  type UpdateMethod,
  type UpdateOutcome,
} from "./auto-update.js"

const roots: string[] = []

/** Temp install root carrying trayambak's package.json marker. */
function makeRoot(version = "0.3.0", name = "Trayambak"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-update-"))
  roots.push(dir)
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }), "utf8")
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe("parseVersion", () => {
  it("parses strict X.Y.Z with optional v prefix and rejects the rest", () => {
    expect(parseVersion("0.3.0")).toEqual({ major: 0, minor: 3, patch: 0 })
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion("1.2")).toBeUndefined()
    expect(parseVersion("1.2.3-rc.1")).toBeUndefined()
    expect(parseVersion("not-a-version")).toBeUndefined()
  })
})

describe("getReleaseType (SKT AI LABS port)", () => {
  it("classifies major/minor/patch jumps", () => {
    expect(getReleaseType("0.3.0", "1.0.0")).toBe("major")
    expect(getReleaseType("0.3.0", "0.4.0")).toBe("minor")
    expect(getReleaseType("0.3.0", "0.3.1")).toBe("patch")
  })

  it("returns unknown for equal, downgraded, or unparseable pairs", () => {
    expect(getReleaseType("0.3.0", "0.3.0")).toBe("unknown")
    expect(getReleaseType("0.4.0", "0.3.0")).toBe("unknown")
    expect(getReleaseType("garbage", "0.3.1")).toBe("unknown")
    expect(getReleaseType("v0.3.0", "0.4.0")).toBe("minor")
  })
})

describe("detectMethod", () => {
  it("prefers npm for node_modules installs, then git, then source", () => {
    expect(detectMethod("C:\\somewhere", "C:\\node_modules\\Trayambak\\dist\\index.js")).toBe("npm")
    expect(detectMethod("/somewhere", "/opt/node_modules/Trayambak/dist/index.js")).toBe("npm")
    const gitRoot = makeRoot()
    fs.mkdirSync(path.join(gitRoot, ".git"))
    expect(detectMethod(gitRoot, "C:\\trayambak\\dist\\index.js")).toBe("git")
    expect(detectMethod(gitRoot, "")).toBe("git")
    expect(detectMethod(makeRoot(), "C:\\trayambak\\dist\\index.js")).toBe("source")
    expect(detectMethod("", "")).toBe("unknown")
  })
})

describe("parseMaxTagVersion", () => {
  it("picks the highest stable tag and ignores prereleases/noise", () => {
    const output = [
      "aaa\trefs/tags/v0.3.0",
      "bbb\trefs/tags/v0.10.0",
      "ccc\trefs/tags/v0.9.9",
      "ddd\trefs/tags/v1.0.0-rc.1",
      "eee\trefs/tags/experiment",
      "fff\trefs/tags/v0.4.0^{}",
      "noise line without tabs",
    ].join("\n")
    expect(parseMaxTagVersion(output)).toBe("0.10.0")
    expect(parseMaxTagVersion("")).toBeUndefined()
    expect(parseMaxTagVersion("aaa\trefs/tags/v1.0.0^{}\nbbb\trefs/tags/v1.0.0")).toBe("1.0.0")
  })
})

describe("fetchLatestNpmVersion", () => {
  const okBody = (version: string) => ({
    ok: true,
    json: async () => ({ version }),
  })

  it("returns the registry version on success", async () => {
    const seen: string[] = []
    const impl = async (url: string): Promise<{ ok: boolean; json(): Promise<unknown> }> => {
      seen.push(url)
      return okBody("9.9.9")
    }
    expect(await fetchLatestNpmVersion("Trayambak", impl)).toBe("9.9.9")
    expect(seen[0]).toBe("https://registry.npmjs.org/trayambak/latest")
  })

  it("returns undefined on non-ok responses, throws, and malformed bodies", async () => {
    expect(await fetchLatestNpmVersion("x", async () => ({ ok: false, json: async () => ({}) }))).toBeUndefined()
    expect(
      await fetchLatestNpmVersion("x", async () => {
        throw new Error("offline")
      }),
    ).toBeUndefined()
    expect(
      await fetchLatestNpmVersion("x", async () => ({ ok: true, json: async () => ({ nope: 1 }) })),
    ).toBeUndefined()
  })
})

describe("findInstallRoot / getInstalledVersion", () => {
  it("finds the nearest trayambak-named package.json walking up", () => {
    const root = makeRoot("9.9.9")
    const nested = path.join(root, "a", "b")
    fs.mkdirSync(nested, { recursive: true })
    expect(findInstallRoot({ startDir: nested, env: {} })).toBe(root)
    expect(getInstalledVersion({ startDir: nested, env: {} })).toBe("9.9.9")
  })

  it("skips package.json files with other names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-update-other-"))
    roots.push(dir)
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "someone-else" }), "utf8")
    expect(findInstallRoot({ startDir: dir, env: {} })).toBeUndefined()
    expect(getInstalledVersion({ startDir: dir, env: {} })).toBeUndefined()
  })

  it("honors TRAYAMBAK_HOME when it points at a valid root", () => {
    const root = makeRoot("7.7.7")
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "auto-update-else-"))
    roots.push(elsewhere)
    expect(findInstallRoot({ startDir: elsewhere, env: { TRAYAMBAK_HOME: root } })).toBe(root)
    expect(getInstalledVersion({ startDir: elsewhere, env: { TRAYAMBAK_HOME: root } })).toBe("7.7.7")
    // A bogus TRAYAMBAK_HOME falls back to the walk-up.
    expect(findInstallRoot({ startDir: root, env: { TRAYAMBAK_HOME: elsewhere } })).toBe(root)
  })
})

describe("checkForUpdate policy (SKT AI LABS upgrade() port)", () => {
  async function run(
    root: string,
    overrides: {
      autoupdate?: boolean | "notify"
      env?: NodeJS.ProcessEnv
      method?: UpdateMethod
      latest?: string
      fetchThrows?: boolean
      apply?: (method: UpdateMethod, latest: string) => Promise<void>
    } = {},
  ): Promise<{ outcome: UpdateOutcome; applied: string[] }> {
    const applied: string[] = []
    const outcome = await checkForUpdate({
      config: { autoupdate: overrides.autoupdate },
      startDir: root,
      deps: {
        env: overrides.env ?? {},
        method: overrides.method ?? "git",
        fetchLatest: async () => {
          if (overrides.fetchThrows) throw new Error("network down")
          return overrides.latest
        },
        applyUpdate: overrides.apply
          ? async (m, v) => overrides.apply!(m, v)
          : async (m, v) => {
              applied.push(`${m}:${v}`)
            },
      },
    })
    return { outcome, applied }
  }

  it("skips when autoupdate is false or the kill-switch env is set", async () => {
    const root = makeRoot()
    const off = await run(root, { autoupdate: false, latest: "0.3.1" })
    expect(off.outcome).toEqual({ kind: "skipped", reason: "autoupdate disabled" })
    const killed = await run(root, { env: { TRAYAMBAK_DISABLE_AUTOUPDATE: "1" }, latest: "0.3.1" })
    expect(killed.outcome.kind).toBe("skipped")
    const noopFlag = await run(root, { env: { TRAYAMBAK_DISABLE_AUTOUPDATE: "0" }, method: "npm", latest: "0.3.1" })
    expect(noopFlag.outcome.kind).toBe("updated") // "0"/"false" values don't disable
  })

  it("skips unsupported install methods before touching the network", async () => {
    const root = makeRoot()
    const { outcome } = await run(root, { method: "source", latest: "0.3.1" })
    expect(outcome).toEqual({ kind: "skipped", reason: "unsupported install method: source" })
  })

  it("skips when the update source is unreachable or throws", async () => {
    const root = makeRoot()
    expect((await run(root, { latest: undefined })).outcome).toEqual({
      kind: "skipped",
      reason: "no update source reachable",
    })
    expect((await run(root, { fetchThrows: true })).outcome.kind).toBe("skipped")
  })

  it("reports up-to-date for equal versions and for local builds ahead", async () => {
    const behind = makeRoot("0.3.0")
    expect(await run(behind, { latest: "0.3.0" })).toMatchObject({ outcome: { kind: "up-to-date" } })
    const ahead = makeRoot("0.5.0")
    const { outcome, applied } = await run(ahead, { latest: "0.3.1" })
    expect(outcome).toEqual({ kind: "up-to-date", current: "0.5.0" })
    expect(applied).toEqual([])
  })

  it('notifies (never auto-applies) under autoupdate: "notify"', async () => {
    const root = makeRoot()
    const { outcome, applied } = await run(root, { autoupdate: "notify", method: "npm", latest: "0.3.1" })
    expect(outcome).toEqual({
      kind: "update-available",
      current: "0.3.0",
      latest: "0.3.1",
      releaseType: "patch",
      auto: false,
    })
    expect(applied).toEqual([])
  })

  it("notifies for minor/major even under autoupdate: true", async () => {
    const root = makeRoot()
    const minor = await run(root, { method: "npm", latest: "0.4.0" })
    expect(minor.outcome).toMatchObject({ kind: "update-available", releaseType: "minor", auto: false })
    expect(minor.applied).toEqual([])
    const major = await run(root, { method: "npm", latest: "1.0.0" })
    expect(major.outcome).toMatchObject({ kind: "update-available", releaseType: "major" })
    expect(major.applied).toEqual([])
  })

  it("auto-applies npm patches under autoupdate: true (SKT AI LABS parity)", async () => {
    const root = makeRoot()
    const { outcome, applied } = await run(root, { method: "npm", latest: "0.3.1" })
    expect(outcome).toEqual({ kind: "updated", previous: "0.3.0", latest: "0.3.1" })
    expect(applied).toEqual(["npm:0.3.1"])
  })

  it("never auto-applies git patches — trayambak deviation, notify instead", async () => {
    const root = makeRoot()
    const { outcome, applied } = await run(root, { method: "git", latest: "0.3.1" })
    expect(outcome).toMatchObject({ kind: "update-available", releaseType: "patch", auto: false })
    expect(applied).toEqual([])
  })

  it("surfaces apply failures as an error outcome", async () => {
    const root = makeRoot()
    const { outcome } = await run(root, {
      method: "npm",
      latest: "0.3.1",
      apply: async () => {
        throw new Error("npm exploded")
      },
    })
    expect(outcome).toEqual({ kind: "error", reason: "npm exploded" })
  })

  it("skips when the install root cannot be located", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-update-noroot-"))
    roots.push(dir)
    const outcome = await checkForUpdate({
      config: {},
      startDir: dir,
      deps: { env: {}, fetchLatest: async () => "1.0.0" },
    })
    expect(outcome).toEqual({ kind: "skipped", reason: "cannot determine installed version" })
  })
})
