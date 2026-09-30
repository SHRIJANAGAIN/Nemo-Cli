/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

describe("vscode-extension manifest", () => {
  it("contributes sidebar + commands", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"))
    expect(pkg.contributes.views["trayambak"].map((v: { id: string }) => v.id).sort()).toEqual(
      ["trayambak.models", "trayambak.sessions", "trayambak.sidebar"].sort(),
    )
    for (const cmd of [
      "trayambak.run",
      "trayambak.openWeb",
      "trayambak.switchModel",
      "trayambak.switchProvider",
      "trayambak.compact",
      "trayambak.review",
      "trayambak.newSession",
      "trayambak.openSessions",
    ]) {
      expect(pkg.contributes.commands.map((c: { command: string }) => c.command)).toContain(cmd)
    }
    for (const setting of [
      "trayambak.provider",
      "trayambak.model",
      "trayambak.baseUrl",
      "trayambak.telemetry",
      "trayambak.inlineCompletion",
    ]) {
      expect(pkg.contributes.configuration.properties[setting]).toBeTruthy()
    }
    expect(pkg.contributes.keybindings.length).toBeGreaterThan(0)
  })

  it("registers a tree provider for every declared tree view", () => {
    const src = fs.readFileSync(path.join(__dirname, "extension.ts"), "utf8")
    for (const view of ["trayambak.sessions", "trayambak.models"]) {
      expect(src).toContain(`registerTreeDataProvider("${view}"`)
    }
  })
})
