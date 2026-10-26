import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COMMANDS,
  GLOBAL_FLAGS,
  completionScript,
  completionShells,
  findCommand,
  flagTypeMap,
  knownFlagNames,
  refuseSystemPromptDump,
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
      if (c.usage && c.usage.includes("nemo")) {
        expect(
          c.usage.startsWith(`nemo ${c.name}`) || c.usage.includes(`nemo ${c.name} `) || c.name === "chat",
        ).toBe(true)
      }
    }
  })
  /**
   * Non-leak guard. The system prompt (tools + memory + rules + mode blocks) is
   * the agent's core secret; a flag that prints it turns any shell history, CI
   * log or crash artifact into a full capability spec. The flag was removed from
   * index.ts — this pins that it cannot come back through the registry, where
   * it would also reappear in `--help` and shell completion.
   */
  it("registers no flag that prints or dumps the system prompt", () => {
    const offenders = GLOBAL_FLAGS.filter((f) => /system.?prompt|prompt.?dump|dump.?prompt/i.test(f.name))
    expect(offenders.map((f) => f.name)).toEqual([])
    expect(knownFlagNames()).not.toContain("dump-system-prompt")
    for (const f of GLOBAL_FLAGS) {
      expect(f.description).not.toMatch(/system prompt/i)
    }
  })
})

describe("help rendering", () => {
  const help = renderRootHelp("nemo")
  it("root help carries Shrijan branding, never third-party credit", () => {
    expect(help).toContain("Shrijan")
    expect(help).not.toContain("NVIDIA")
  })
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
      const usage = c.usage ?? `nemo ${c.name}`
      const row = help.split("\n").find((l) => l.startsWith(`  ${usage}`))
      expect(row, `missing help row for ${c.name}`).toBeDefined()
      expect(row!.slice(2 + usage.length), `glued summary for ${c.name}`).toMatch(/^ /)
    }
  })
  it("root help is bin-aware: usage rows follow the invoking shim", () => {
    const nemoCodeHelp = renderRootHelp("nemo-code")
    for (const c of COMMANDS.filter((x) => !x.hidden)) {
      expect(nemoCodeHelp, `row for ${c.name} should use the nemo-code name`).toContain(
        `  nemo-code ${c.name}`,
      )
    }
    // The default bin still renders its own name.
    expect(help).toContain(`  nemo config `)
  })
  it("command help shows usage and description", () => {
    const spec = findCommand("web")!
    const h = renderCommandHelp(spec, "nemo")
    expect(h).toContain("nemo web")
    expect(h).toContain(spec.usage!.replace(/nemo/g, "nemo"))
    expect(h).toContain("Global flags:")
  })
  it("command help renders command flags", () => {
    const h = renderCommandHelp(findCommand("serve")!, "nemo")
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
    const s = completionScript("bash", "nemo")
    expect(s).toContain("complete -F _nemo_complete nemo")
    expect(s).toContain("serve")
    expect(s).not.toContain("\nchat ") // hidden commands stay out of the wordlist
  })
  it("fish script has one completion line per visible command", () => {
    const s = completionScript("fish", "nemo")
    const lines = s.split("\n").filter((l) => l.startsWith("complete -c"))
    expect(lines.length).toBe(COMMANDS.filter((c) => !c.hidden).length)
  })
  it("powershell script registers an argument completer", () => {
    const s = completionScript("powershell", "nemo")
    expect(s).toContain("Register-ArgumentCompleter")
    expect(s).toContain("'exec'")
  })
  it("throws on unsupported shells", () => {
    expect(() => completionScript("tcsh", "nemo")).toThrow(/unsupported shell/)
  })
})

describe("dump-system-prompt lock", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    process.exitCode = 0
  })

  it("refuses the flag AND stores the attempt in the security trail", () => {
    const file = join(mkdtempSync(join(tmpdir(), "dump-lock-")), "security.log")
    vi.stubEnv("NEMO_SECURITY_LOG", file)
    const origWrite = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      const prevExit = process.exitCode
      expect(refuseSystemPromptDump(["nemo", "--dump-system-prompt"], "nemo")).toBe(true)
      expect(process.exitCode).toBe(2)
      process.exitCode = prevExit
    } finally {
      process.stderr.write = origWrite
    }
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    const evt = JSON.parse(lines[0]) as { type: string; flag: string }
    expect(evt.type).toBe("prompt_exfil_attempt")
    expect(evt.flag).toBe("--dump-system-prompt")
  })

  it("passes clean invocations through with no trail write", () => {
    const file = join(mkdtempSync(join(tmpdir(), "dump-lock-clean-")), "security.log")
    vi.stubEnv("NEMO_SECURITY_LOG", file)
    expect(refuseSystemPromptDump(["nemo", "--version"], "nemo")).toBe(false)
    expect(existsSync(file)).toBe(false)
  })
})
