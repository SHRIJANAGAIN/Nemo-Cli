/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import type { AddressInfo } from "node:net"

import type * as DoctorModule from "./doctor.js"

/**
 * doctorCommand/infoCommand print via process.stdout.write and flip
 * process.exitCode on failure — both are captured and restored around every
 * test. Config comes from `<cwd>/.trayambak/config.json` in a throwaway cwd,
 * and a temp home is installed while doctor.js loads so llama-cpp-bin's
 * module-load path constants (KNOWN_CANDIDATES, GPU cache) point into the
 * sandbox instead of the real profile. The server check is exercised against
 * local 127.0.0.1 listeners (reachable / refusing / unparseable); the 3s
 * timeout branch is deliberately not tested.
 */

type ExitCode = number | string | null | undefined

let doctor: typeof DoctorModule
let tmp = ""
let home = ""
let originalCwd = ""
let out = ""
// Structural type: only mockRestore() is called, and the concrete overload
// set of process.stdout.write doesn't fit vitest's default MockInstance.
let writeSpy: { mockRestore: () => void } | undefined
let savedExitCode: ExitCode
let savedUserprofile: string | undefined
let savedHome: string | undefined
const savedEnv: Record<string, string | undefined> = {}
const servers: http.Server[] = []

const ENV_KEYS = [
  "TRAYAMBAK_BASE_URL",
  "TRAYAMBAK_MODEL_PATH",
  "TRAYAMBAK_LLAMACPP_BIN",
  "TRAYAMBAK_MODEL",
  "TRAYAMBAK_PROVIDER",
  "TRAYAMBAK_API_KEY",
  "TRAYAMBAK_CWD",
  "TRAYAMBAK_MAX_TURNS",
  "TRAYAMBAK_NATIVE_TOOLS",
  "TRAYAMBAK_SHELL_COMMAND",
] as const

const configFile = (): string => path.join(tmp, ".trayambak", "config.json")

function writeConfig(value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true })
  fs.writeFileSync(configFile(), JSON.stringify(value, null, 2), "utf8")
}

function exitCode(): ExitCode {
  return (process as { exitCode?: ExitCode }).exitCode
}

function setExitCode(value: ExitCode): void {
  ;(process as { exitCode?: ExitCode }).exitCode = value
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function startServer(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler)
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(server))
    server.once("error", reject)
  })
}

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port
}

/** Bind an ephemeral port and release it, so connecting gets refused fast. */
async function refusedPort(): Promise<number> {
  const server = await startServer(() => undefined)
  const port = portOf(server)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  servers.splice(servers.indexOf(server), 1)
  return port
}

async function closeServers(): Promise<void> {
  for (const server of [...servers]) {
    servers.splice(servers.indexOf(server), 1)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Node ≥19 keeps connections alive by default; without this,
      // close() would wait for idle sockets until the hook times out.
      ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
    })
  }
}

beforeAll(async () => {
  originalCwd = process.cwd()
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-doctor-home-"))

  savedUserprofile = process.env.USERPROFILE
  savedHome = process.env.HOME
  process.env.USERPROFILE = home
  process.env.HOME = home
  doctor = await import("./doctor.js")
  process.env.USERPROFILE = savedUserprofile
  process.env.HOME = savedHome
}, 60_000)

afterAll(() => {
  process.chdir(originalCwd)
  for (const dir of [home]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trayambak-doctor-"))
  fs.mkdirSync(path.join(tmp, ".trayambak"), { recursive: true })
  process.chdir(tmp)

  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }

  savedExitCode = exitCode()
  setExitCode(undefined)

  out = ""
  writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as unknown as typeof process.stdout.write)
})

afterEach(async () => {
  await closeServers()
  writeSpy?.mockRestore()
  writeSpy = undefined
  setExitCode(savedExitCode)
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

describe("infoCommand", () => {
  it("prints version, runtime and the resolved config", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8")
    writeConfig({ model: "info-model", nativeTools: false, maxTurns: 42 })

    doctor.infoCommand()

    expect(out.split("\n")[0]).toBe("trayambak 9.9.9")
    expect(out).toContain(`node      v${process.versions.node}`)
    expect(out).toContain(`platform  ${process.platform} ${process.arch}`)
    expect(out).toContain(`cwd       ${tmp}`)
    expect(out).toContain("baseUrl   https://integrate.api.nvidia.com")
    expect(out).toContain("model     info-model")
    expect(out).toMatch(/^shell\s+\S.*$/m)
    expect(out).toContain("maxTurns  42")
    expect(out).toContain("tools     text fallback")
  })
})

describe("doctorCommand", () => {
  it("passes every check when config, binary and server are in place", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }))
    })
    writeConfig({ baseUrl: `http://127.0.0.1:${portOf(server)}` })
    const bin = path.join(tmp, "llama-server.exe")
    fs.writeFileSync(bin, "fake binary", "utf8")
    process.env.TRAYAMBAK_LLAMACPP_BIN = bin

    await doctor.doctorCommand()

    expect(countOccurrences(out, " PASS ")).toBe(6)
    expect(out).not.toContain(" FAIL ")
    expect(out).toContain("6/6 checks passed")
    expect(out).not.toContain("Failed checks")
    expect(exitCode()).toBeUndefined()
  })

  it("fails on a refused connection and a missing model, and sets exitCode 1", async () => {
    const port = await refusedPort()
    const modelPath = path.join(tmp, "missing.gguf")
    writeConfig({ baseUrl: `http://127.0.0.1:${port}`, modelPath })

    await doctor.doctorCommand()

    expect(out).toContain("Failed checks:")
    expect(out).toContain("connection failed")
    expect(out).toContain(`not found: ${modelPath}`)
    expect(out).toContain("checks passed")
    expect(exitCode()).toBe(1)
  })

  it("flags an unparseable server response without blaming the unconfigured model", async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html")
      res.end("<html>not json</html>")
    })
    writeConfig({ baseUrl: `http://127.0.0.1:${portOf(server)}` })
    // Pin the binary check to PASS via env so the failure section below is
    // deterministic regardless of llama.cpp installs on the host machine.
    const bin = path.join(tmp, "llama-server.exe")
    fs.writeFileSync(bin, "fake binary", "utf8")
    process.env.TRAYAMBAK_LLAMACPP_BIN = bin

    await doctor.doctorCommand()

    expect(out).toContain("returned an unparseable response")
    // modelPath is unset: the GGUF check passes with the "not configured"
    // detail, so it must not appear among the failures.
    const failedSection = out.slice(out.indexOf("Failed checks:"))
    expect(failedSection).not.toContain("GGUF model")
    expect(failedSection).not.toContain("llama.cpp server binary")
    expect(exitCode()).toBe(1)
  })
})
