/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { beforeEach, describe, expect, it } from "vitest"
import { SlashCommandRegistry, createSlashRegistry, type CommandCategory, type SlashCommandDef } from "./registry.js"

const def = (overrides: Partial<SlashCommandDef> = {}): SlashCommandDef => ({
  name: "help",
  description: "Show help",
  category: "Info",
  ...overrides,
})

describe("SlashCommandRegistry", () => {
  let registry: SlashCommandRegistry

  beforeEach(() => {
    registry = createSlashRegistry()
  })

  it("normalizes the registered name: trims, strips the leading slash, lowercases", () => {
    registry.register(def({ name: "  /Help " }))
    expect(registry.resolve("help")?.canonical).toBe("help")
    expect(registry.resolve("/HELP")?.canonical).toBe("help")
    expect(registry.resolve(" help ")?.canonical).toBe("help")
    expect(registry.resolve("nope")).toBeUndefined()
  })

  it("normalizes aliases like the name and resolves every alias to the same command", () => {
    registry.register(def({ name: "list", aliases: ["/Ls", " list-all "] }))
    const byName = registry.resolve("list")
    expect(byName).toBeDefined()
    expect(registry.resolve("/LS")).toBe(byName)
    expect(registry.resolve("list-all")).toBe(byName)
    expect(byName?.canonical).toBe("list")
    expect(byName?.aliases).toEqual(["ls", "list-all", "list"])
  })

  it("resolveAlias maps an alias to its canonical name and an unknown key to itself", () => {
    registry.register(def({ name: "new", aliases: ["create"] }))
    expect(registry.resolveAlias("/Create")).toBe("new")
    expect(registry.resolveAlias(" NEW ")).toBe("new")
    expect(registry.resolveAlias("/whatever")).toBe("whatever")
  })

  it("groups commands by category and returns [] for an unregistered category", () => {
    registry.register(def({ name: "help", category: "Info" }))
    registry.register(def({ name: "model", category: "Configuration" }))
    expect(registry.byCategory("Info").map((c) => c.canonical)).toEqual(["help"])
    expect(registry.byCategory("Configuration").map((c) => c.canonical)).toEqual(["model"])
    expect(registry.byCategory("Exit")).toEqual([])
  })

  it("preserves definition metadata on the resolved command", () => {
    registry.register(
      def({
        name: "run",
        description: "Run a target",
        category: "Tools & Skills",
        argsHint: "<target>",
        cliOnly: true,
        gatewayOnly: false,
        busyPolicy: "interrupt_then_dispatch",
      }),
    )
    const cmd = registry.resolve("run")
    expect(cmd?.description).toBe("Run a target")
    expect(cmd?.category).toBe("Tools & Skills")
    expect(cmd?.argsHint).toBe("<target>")
    expect(cmd?.cliOnly).toBe(true)
    expect(cmd?.gatewayOnly).toBe(false)
    expect(cmd?.busyPolicy).toBe("interrupt_then_dispatch")
  })

  it("registers in a chain: register() returns the registry itself", () => {
    const returned = registry.register(def({ name: "a" })).register(def({ name: "b", category: "Session" }))
    expect(returned).toBe(registry)
    expect(registry.resolve("a")).toBeDefined()
    expect(registry.resolve("b")).toBeDefined()
  })

  it("all() and flat() index every lookup key; aliases point at the same command object", () => {
    registry.register(def({ name: "go", aliases: ["g"] }))
    const all = registry.all()
    // One entry per lookup key ("go" and "g"), both the same command.
    expect(all).toHaveLength(2)
    expect(all[0]).toBe(all[1])

    const flat = registry.flat()
    expect(Object.keys(flat).sort()).toEqual(["g", "go"])
    expect(flat["g"]).toBe(flat["go"])
  })

  it("clear() drops names, aliases and categories", () => {
    registry.register(def({ name: "go", aliases: ["g"], category: "Session" }))
    registry.clear()
    expect(registry.resolve("go")).toBeUndefined()
    expect(registry.resolve("g")).toBeUndefined()
    expect(registry.resolveAlias("g")).toBe("g")
    expect(registry.all()).toEqual([])
    expect(registry.byCategory("Session" as CommandCategory)).toEqual([])
    expect(registry.flat()).toEqual({})
  })

  it("an empty registry resolves nothing", () => {
    expect(registry.resolve("anything")).toBeUndefined()
    expect(registry.all()).toEqual([])
    expect(registry.flat()).toEqual({})
  })
})
