/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

describe("vscode-extension manifest", () => {
  it("contributes sidebar + commands", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"))
    expect(pkg.contributes.views["trayambak"].length).toBe(1)
    expect(pkg.contributes.commands.map((c: { command: string }) => c.command)).toContain("trayambak.run")
  })
})
