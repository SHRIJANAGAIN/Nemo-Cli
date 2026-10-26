/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

describe("vscode-extension manifest", () => {
  it("contributes sidebar + commands", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"))
    expect(pkg.contributes.views["nemo"].map((v: { id: string }) => v.id).sort()).toEqual(
      ["nemo.models", "nemo.sessions", "nemo.sidebar"].sort(),
    )
    for (const cmd of [
      "nemo.run",
      "nemo.openWeb",
      "nemo.switchModel",
      "nemo.switchProvider",
      "nemo.compact",
      "nemo.review",
      "nemo.newSession",
      "nemo.openSessions",
    ]) {
      expect(pkg.contributes.commands.map((c: { command: string }) => c.command)).toContain(cmd)
    }
    for (const setting of [
      "nemo.provider",
      "nemo.model",
      "nemo.baseUrl",
      "nemo.inlineCompletion",
    ]) {
      expect(pkg.contributes.configuration.properties[setting]).toBeTruthy()
    }
    expect(pkg.contributes.keybindings.length).toBeGreaterThan(0)
  })

  it("registers a tree provider for every declared tree view", () => {
    const src = fs.readFileSync(path.join(__dirname, "extension.ts"), "utf8")
    for (const view of ["nemo.sessions", "nemo.models"]) {
      expect(src).toContain(`registerTreeDataProvider("${view}"`)
    }
  })
})
