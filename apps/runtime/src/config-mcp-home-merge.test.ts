/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "./config.js"

/**
 * Home mcpServers survive a repo-local config file.
 *
 * `configDir()` prefers `<cwd>/.trayambak/config.json` over
 * `~/.trayambak/config.json` wholesale — a project file carrying
 * `"mcpServers": {}` silently uninstalled every home server ("mcp is not
 * coming" — observed live: puppeteer vanished when running from a
 * checkout). Home servers merge UNDER the active file, per server, with
 * the file winning per key (same rule as ./.trayambak/mcp.json).
 */

const savedConfig = process.env.TRAYAMBAK_CONFIG
const savedUserprofile = process.env.USERPROFILE
const savedHome = process.env.HOME
let savedCwd: string | undefined
const tmpRoots: string[] = []

afterEach(() => {
  if (savedCwd !== undefined) process.chdir(savedCwd)
  savedCwd = undefined
  if (savedConfig === undefined) delete process.env.TRAYAMBAK_CONFIG
  else process.env.TRAYAMBAK_CONFIG = savedConfig
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

const stdio = (cmd: string): Record<string, unknown> => ({ command: ["node", cmd] })

/** Fake HOME carrying `homeConfig` + cd into a repo carrying `repoConfig`. */
function enterRepoWithHome(homeConfig: unknown, repoConfig: unknown): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-home-"))
  tmpRoots.push(home)
  fs.mkdirSync(path.join(home, ".trayambak"), { recursive: true })
  fs.writeFileSync(path.join(home, ".trayambak", "config.json"), JSON.stringify(homeConfig))
  process.env.USERPROFILE = home
  process.env.HOME = home
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-repo-"))
  tmpRoots.push(repo)
  fs.mkdirSync(path.join(repo, ".trayambak"), { recursive: true })
  fs.writeFileSync(path.join(repo, ".trayambak", "config.json"), JSON.stringify(repoConfig))
  savedCwd = process.cwd()
  delete process.env.TRAYAMBAK_CONFIG
  process.chdir(repo)
}

describe("home mcpServers merge under a repo-local file", () => {
  it("an empty project map no longer uninstalls home servers (the reported bug)", () => {
    enterRepoWithHome({ mcpServers: { puppeteer: stdio("pup.js") } }, { mcpServers: {} })
    const servers = loadConfig().mcpServers ?? {}
    expect(Object.keys(servers)).toEqual(["puppeteer"])
  })

  it("a missing project key leaves home servers alone", () => {
    enterRepoWithHome({ mcpServers: { puppeteer: stdio("pup.js") } }, { model: "x" })
    expect(Object.keys(loadConfig().mcpServers ?? {})).toEqual(["puppeteer"])
  })

  it("the repo file wins per server", () => {
    enterRepoWithHome(
      { mcpServers: { shared: stdio("home.js"), homeOnly: stdio("h.js") } },
      { mcpServers: { shared: stdio("repo.js") } },
    )
    const servers = loadConfig().mcpServers ?? {}
    expect(Object.keys(servers).sort()).toEqual(["homeOnly", "shared"])
    expect((servers["shared"] as { command: string[] }).command).toEqual(["node", "repo.js"])
  })

  it("an explicit --config file stands alone (no home merge)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-home-"))
    tmpRoots.push(home)
    fs.mkdirSync(path.join(home, ".trayambak"), { recursive: true })
    fs.writeFileSync(
      path.join(home, ".trayambak", "config.json"),
      JSON.stringify({ mcpServers: { puppeteer: stdio("pup.js") } }),
    )
    process.env.USERPROFILE = home
    process.env.HOME = home
    const explicit = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-explicit-"))
    tmpRoots.push(explicit)
    const cfgFile = path.join(explicit, "my.json")
    fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { solo: stdio("s.js") } }))
    process.env.TRAYAMBAK_CONFIG = cfgFile
    savedCwd = process.cwd()
    process.chdir(explicit)
    expect(Object.keys(loadConfig().mcpServers ?? {})).toEqual(["solo"])
  })
})
