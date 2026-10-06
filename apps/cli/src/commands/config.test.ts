/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { configCommand } from "./config.js"

/**
 * `trayambak config get/set` round-trips through <cwd>/.trayambak/config.json
 * (configDir() prefers a project-local .trayambak over ~/.trayambak), so every
 * case here chdirs into a throwaway dir with its own .trayambak — the real
 * home directory and the repo's own .trayambak/ are never touched.
 *
 * TRAYAMBAK_* env vars that loadConfig() folds over the file are cleared for
 * the duration of each test so assertions are about FILE state.
 */

const ENV_KEYS = [
  "TRAYAMBAK_MODEL",
  "TRAYAMBAK_BASE_URL",
  "TRAYAMBAK_API_KEY",
  "TRAYAMBAK_PROVIDER",
  "TRAYAMBAK_MAX_TURNS",
  "TRAYAMBAK_TEMPERATURE",
  "TRAYAMBAK_THEME",
  "TRAYAMBAK_MCP_SERVERS",
  "TRAYAMBAK_CWD",
] as const

let tmp = ""
let originalCwd = ""
const savedEnv: Record<string, string | undefined> = {}
let out = ""
let errOut = ""
let savedExitCode: number | undefined
// Structural type: only mockRestore() is ever called on these spies, and the
// concrete overload set of process.stdout.write doesn't fit vitest's
// default MockInstance<(this: unknown, ...args: unknown[]) => unknown>.
let writeSpy: { mockRestore: () => void } | undefined
let errSpy: { mockRestore: () => void } | undefined

const configFile = (): string => path.join(tmp, ".trayambak", "config.json")

function seedConfig(value: unknown): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(value, null, 2), "utf8")
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configFile(), "utf8")) as Record<string, unknown>
}

beforeEach(() => {
  originalCwd = process.cwd()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-config-"))
  fs.mkdirSync(path.join(tmp, ".trayambak"), { recursive: true })
  process.chdir(tmp)

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }

  out = ""
  errOut = ""
  savedExitCode = process.exitCode as number | undefined
  process.exitCode = undefined
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as unknown as typeof process.stdout.write)
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
    errOut += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as unknown as typeof process.stderr.write)
})

afterEach(() => {
  writeSpy?.mockRestore()
  writeSpy = undefined
  errSpy?.mockRestore()
  errSpy = undefined
  process.exitCode = savedExitCode
  process.chdir(originalCwd)
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe("configCommand set", () => {
  it("persists a string value and reads it back with get", () => {
    configCommand(["set", "model", "my-model"])
    expect(out).toBe("Set model = my-model\n")
    expect(readConfig().model).toBe("my-model")

    out = ""
    configCommand(["get", "model"])
    expect(out).toBe("my-model\n")
  })

  it("coerces booleans and numbers instead of storing strings", () => {
    configCommand(["set", "nativeTools", "false"])
    expect(readConfig().nativeTools).toBe(false)
    expect(typeof readConfig().nativeTools).toBe("boolean")

    out = ""
    configCommand(["set", "maxTurns", "42"])
    expect(readConfig().maxTurns).toBe(42)
    expect(typeof readConfig().maxTurns).toBe("number")

    out = ""
    configCommand(["get", "maxTurns"])
    expect(out).toBe("42\n")
  })

  it("keeps non-literal text (and multi-word values) as a string", () => {
    configCommand(["set", "model", "not-a-number-xyz"])
    expect(readConfig().model).toBe("not-a-number-xyz")

    out = ""
    configCommand(["set", "shellCommand", "cmd", "/c"])
    expect(readConfig().shellCommand).toBe("cmd /c")
    expect(out).toBe("Set shellCommand = cmd /c\n")
  })

  it("normalizes flag-style keys to canonical camelCase", () => {
    configCommand(["set", "--base-url", "http://example.test/v1"])
    expect(out).toBe("Set baseUrl = http://example.test/v1\n")
    const file = readConfig()
    expect(file.baseUrl).toBe("http://example.test/v1")
    expect(file["--base-url"]).toBeUndefined()

    out = ""
    configCommand(["set", "--api-key", "s3cr3t"])
    expect(readConfig().apiKey).toBe("s3cr3t")
  })

  it("merges successive sets instead of replacing the file", () => {
    configCommand(["set", "model", "alpha"])
    configCommand(["set", "maxTurns", "9"])
    const file = readConfig()
    expect(file.model).toBe("alpha")
    expect(file.maxTurns).toBe(9)
    expect(Object.keys(file).length).toBe(2)
  })

  it("never prints secret values (masks apiKey on get and set)", () => {
    configCommand(["set", "apiKey", "nvapi-abcdefghijklmnopqrstuvwxyz012345"])
    expect(out).not.toContain("nvapi-abcdefghijklmnopqrstuvwxyz012345")
    expect(out).toContain("(set,")
    expect(readConfig().apiKey).toBe("nvapi-abcdefghijklmnopqrstuvwxyz012345")
    out = ""
    configCommand(["get", "apiKey"])
    expect(out).not.toContain("nvapi-abcdefghijklmnopqrstuvwxyz012345")
    expect(out).toContain("(set,")
  })

  it("refuses to write when the value is missing", () => {
    configCommand(["set", "model"])
    expect(out).toBe("Usage: trayambak config set <key> <value>\n")
    expect(fs.existsSync(configFile())).toBe(false)
  })

  it("refuses to write when the key is missing", () => {
    configCommand(["set"])
    expect(out).toBe("Usage: trayambak config set <key> <value>\n")
    expect(fs.existsSync(configFile())).toBe(false)
  })
})

describe("configCommand get", () => {
  it("dumps every key as `key = value` when no key is given", () => {
    seedConfig({ model: "seeded-model", maxTurns: 7 })
    configCommand(["get"])
    expect(out).toContain("model = seeded-model\n")
    expect(out).toContain("maxTurns = 7\n")
    expect(out).toContain("baseUrl = ")
  })

  it("rejects unknown keys instead of printing false success (#11/#12)", () => {
    // sanitizeConfig() rebuilds a typed config and drops unknown keys, so a
    // bare success message would be a lie: nothing would ever take effect.
    configCommand(["set", "totallyUnknownKey", "1"])
    expect(errOut).toContain('Unknown config key "totallyUnknownKey"')
    expect(process.exitCode).toBe(2)
    expect(out).toBe("")
    // ...and the dead write is scrubbed, not left littering config.json.
    expect(readConfig().totallyUnknownKey).toBeUndefined()

    out = ""
    errOut = ""
    process.exitCode = undefined
    configCommand(["set", "approvalMode", "plan"])
    expect(errOut).toContain('Unknown config key "approvalMode"')
    expect(process.exitCode).toBe(2)
  })

  it("rejects unknown keys on get (#18)", () => {
    seedConfig({ model: "seeded-model" })
    configCommand(["get", "doesNotExist"])
    expect(errOut).toContain('Unknown config key "doesNotExist"')
    expect(process.exitCode).toBe(2)
    expect(out).toBe("")
  })

  it("round-trips llama.cpp sizing keys instead of silently dropping them", () => {
    configCommand(["set", "ctxSize", "8192"])
    expect(out).toBe("Set ctxSize = 8192\n")
    expect(readConfig().ctxSize).toBe(8192)

    out = ""
    configCommand(["get", "ctxSize"])
    expect(out).toBe("8192\n")
  })

  it("lets TRAYAMBAK_MODEL win over the file value", () => {
    seedConfig({ model: "file-model" })
    process.env.TRAYAMBAK_MODEL = "env-model"
    configCommand(["get", "model"])
    expect(out).toBe("env-model\n")
  })

  it("reads legacy `--flag` keys from the file as their canonical key", () => {
    // Older builds persisted flag names verbatim; loadConfig maps them back.
    seedConfig({ "--model": "legacy-model" })
    configCommand(["get", "model"])
    expect(out).toBe("legacy-model\n")
  })
})

describe("configCommand usage", () => {
  it("prints the usage block for an unknown subcommand", () => {
    configCommand(["frobnicate", "x"])
    expect(out).toBe("Usage:\n  trayambak config get [key]\n  trayambak config set <key> <value>\n")
  })

  it("prints the usage block when called with no arguments", () => {
    configCommand([])
    expect(out).toContain("trayambak config get [key]")
    expect(out).toContain("trayambak config set <key> <value>")
  })
})
