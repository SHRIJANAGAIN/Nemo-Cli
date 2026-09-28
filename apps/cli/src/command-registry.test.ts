import { describe, expect, it } from "vitest"
import {
  COMMANDS,
  GLOBAL_FLAGS,
  completionScript,
  completionShells,
  findCommand,
  flagTypeMap,
  knownFlagNames,
  renderCommandHelp,
  renderRootHelp,
} from "./command-registry.js"

describe("command registry", () => {
  it("every command has a name and summary", () => {
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(c.summary.length).toBeGreaterThan(0)
    }
  })
  it("command names are unique", () => {
    const names = COMMANDS.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })
  it("findCommand resolves registered and unknown commands", () => {
    expect(findCommand("serve")?.name).toBe("serve")
    expect(findCommand("frobnicate")).toBeUndefined()
  })
  it("every command with usage uses its own name", () => {
    for (const c of COMMANDS) {
      if (c.usage && c.usage.includes("trayambak")) {
        expect(
          c.usage.startsWith(`trayambak ${c.name}`) || c.usage.includes(`trayambak ${c.name} `) || c.name === "chat",
        ).toBe(true)
      }
    }
  })
})

describe("help rendering", () => {
  const help = renderRootHelp("trayambak")
  it("root help lists every visible command", () => {
    for (const c of COMMANDS.filter((x) => !x.hidden)) {
      expect(help).toContain(c.name)
    }
  })
  it("root help hides hidden commands", () => {
    expect(help).not.toContain("chat                        ")
  })
  it("root help documents exit codes and help subcommand", () => {
    expect(help).toContain("Exit codes:")
    expect(help).toContain("help <command>")
  })
  it("every usage line is separated from its summary by at least one space", () => {
    // Regression: over-long usage strings exceeded the pad width and the
    // summary was glued on ("…[key] [value]Manage configuration values").
    for (const c of COMMANDS.filter((x) => !x.hidden)) {
      const usage = c.usage ?? `trayambak ${c.name}`
      const row = help.split("\n").find((l) => l.startsWith(`  ${usage}`))
      expect(row, `missing help row for ${c.name}`).toBeDefined()
      expect(row!.slice(2 + usage.length), `glued summary for ${c.name}`).toMatch(/^ /)
    }
  })
  it("root help is bin-aware: usage rows follow the invoking shim", () => {
    const sktHelp = renderRootHelp("skt")
    for (const c of COMMANDS.filter((x) => !x.hidden)) {
      expect(sktHelp, `row for ${c.name} should use the skt name`).toContain(`  skt ${c.name}`)
    }
    // The default bin still renders its own name.
    expect(help).toContain(`  trayambak config `)
  })
  it("command help shows usage and description", () => {
    const spec = findCommand("web")!
    const h = renderCommandHelp(spec, "skt")
    expect(h).toContain("skt web")
    expect(h).toContain(spec.usage!.replace(/trayambak/g, "skt"))
    expect(h).toContain("Global flags:")
  })
  it("command help renders command flags", () => {
    const h = renderCommandHelp(findCommand("serve")!, "trayambak")
    expect(h).toContain("--port")
    expect(h).toContain("Command flags:")
  })
})

describe("flag name sets", () => {
  it("knownFlagNames includes global flags and command flags with aliases", () => {
    const names = knownFlagNames(findCommand("web"))
    expect(names).toContain("model")
    expect(names).toContain("m")
    expect(names).toContain("port")
    expect(names).toContain("host")
    expect(names).toContain("token")
    expect(names).toContain("help")
    expect(names).toContain("ink") // internal
  })
  it("flagTypeMap types booleans and strings correctly", () => {
    const map = flagTypeMap(findCommand("serve"))
    expect(map.get("dev")).toBe("boolean")
    expect(map.get("port")).toBe("string")
    expect(map.get("help")).toBe("boolean")
    expect(map.get("model")).toBe("string")
  })
  it("global flags all have descriptions", () => {
    for (const f of GLOBAL_FLAGS) {
      expect(f.description.length).toBeGreaterThan(0)
    }
  })
})

describe("shell completion", () => {
  it("supports bash, zsh, fish, powershell", () => {
    expect(completionShells().sort()).toEqual(["bash", "fish", "powershell", "zsh"])
  })
  it("bash script completes visible commands and registers both binaries", () => {
    const s = completionScript("bash", "trayambak")
    expect(s).toContain("complete -F _trayambak_complete trayambak")
    expect(s).toContain("serve")
    expect(s).not.toContain("\nchat ") // hidden commands stay out of the wordlist
  })
  it("fish script has one completion line per visible command", () => {
    const s = completionScript("fish", "trayambak")
    const lines = s.split("\n").filter((l) => l.startsWith("complete -c"))
    expect(lines.length).toBe(COMMANDS.filter((c) => !c.hidden).length)
  })
  it("powershell script registers an argument completer", () => {
    const s = completionScript("powershell", "trayambak")
    expect(s).toContain("Register-ArgumentCompleter")
    expect(s).toContain("'exec'")
  })
  it("throws on unsupported shells", () => {
    expect(() => completionScript("tcsh", "trayambak")).toThrow(/unsupported shell/)
  })
})
