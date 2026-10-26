/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { configPath, loadConfig } from "./config.js"

const savedConfig = process.env.NEMO_CONFIG
const savedUserprofile = process.env.USERPROFILE
const savedHome = process.env.HOME
let savedCwd: string | undefined
const tmpRoots: string[] = []

afterEach(() => {
  if (savedCwd !== undefined) process.chdir(savedCwd)
  savedCwd = undefined
  if (savedConfig === undefined) delete process.env.NEMO_CONFIG
  else process.env.NEMO_CONFIG = savedConfig
  if (savedUserprofile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserprofile
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  for (const dir of tmpRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

function fakeHome(config: unknown): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-home-"))
  tmpRoots.push(home)
  fs.mkdirSync(path.join(home, ".nemo"), { recursive: true })
  fs.writeFileSync(path.join(home, ".nemo", "config.json"), JSON.stringify(config))
  process.env.USERPROFILE = home
  process.env.HOME = home
  return home
}

function enterRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-repo-"))
  tmpRoots.push(repo)
  savedCwd = process.cwd()
  delete process.env.NEMO_CONFIG
  process.chdir(repo)
  return repo
}

describe("which config file is active", () => {
  it("a bare .nemo/ directory (harness state) does NOT hijack the home config", () => {
    const home = fakeHome({ apiKey: "nvapi-home", model: "home-model" })
    const repo = enterRepo()
    fs.mkdirSync(path.join(repo, ".nemo"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".nemo", "harness.json"), "{}")

    expect(configPath()).toBe(path.join(home, ".nemo", "config.json"))
    const cfg = loadConfig()
    expect(cfg.apiKey).toBe("nvapi-home")
    expect(cfg.model).toBe("home-model")
  })

  it("a project that ships .nemo/config.json still wins", () => {
    fakeHome({ apiKey: "nvapi-home", model: "home-model" })
    const repo = enterRepo()
    fs.mkdirSync(path.join(repo, ".nemo"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".nemo", "config.json"), JSON.stringify({ model: "repo-model" }))

    expect(configPath()).toBe(path.join(repo, ".nemo", "config.json"))
    expect(loadConfig().model).toBe("repo-model")
  })
})
