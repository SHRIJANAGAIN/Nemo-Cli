/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
  MAX_PE_SCAN_BYTES,
  acWorkloadIncompatible,
  binaryImportsMsysCygwin,
  importsMsysCygwin,
  resolveExecutable,
} from "./ac-workload.js"
import { spawnProcess } from "./spawn.js"
import { setWindowsAcProbeForTests } from "./windows-ac.js"
import { SandboxType, type SpawnRequest } from "./types.js"

/**
 * AppContainer workload compatibility (ac-workload.ts).
 *
 * The failure this pins: Git-bash — `detectDefaultShell()`'s default on
 * Windows — is MSYS-linked, dies inside the AppContainer in DllMain
 * (`NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0…)` → 0xC0000022 →
 * exit 0xC0000142) and every bash run failed before its first instruction.
 *
 * Three layers are covered: the pure PE import-table parse (synthetic
 * fixtures, platform-neutral), the file/PATH resolution half, and the
 * end-to-end spawn — the container pre-empted by an honest policy-only run
 * that actually executes the command and tells the truth in the child's
 * sandbox-metadata stamps.
 */

const GIT_DIR = "C:\\Program Files\\Git"
/** Git's dispatcher stub — the shell detectDefaultShell() points at. NOT MSYS-linked. */
const GIT_STUB_BASH = `${GIT_DIR}\\bin\\bash.exe`
/** The real MSYS bash the stub launches — imports msys-2.0.dll. */
const GIT_REAL_BASH = `${GIT_DIR}\\usr\\bin\\bash.exe`
const HAVE_GIT_BASH = process.platform === "win32" && fs.existsSync(GIT_STUB_BASH)

/**
 * Minimal PE image (PE32 or PE32+) with one section and an import table
 * holding `dllNames` — enough structure for the parser, nothing else.
 */
function buildPe(dllNames: string[], opts: { pe32Plus?: boolean } = {}): Buffer {
  const pe32Plus = opts.pe32Plus === true
  const buf = Buffer.alloc(0x800)
  buf.write("MZ", 0, "latin1")
  buf.writeUInt32LE(0x80, 0x3c) // e_lfanew
  const pe = 0x80
  buf.write("PE\0\0", pe, "latin1")
  const coff = pe + 4
  buf.writeUInt16LE(0x8664, coff) // machine
  buf.writeUInt16LE(1, coff + 2) // numberOfSections
  const optSize = pe32Plus ? 0xf0 : 0xe0
  buf.writeUInt16LE(optSize, coff + 16) // sizeOfOptionalHeader
  const opt = coff + 20
  buf.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, opt) // magic
  buf.writeUInt32LE(0x200, opt + 60) // sizeOfHeaders
  const dd = opt + (pe32Plus ? 112 : 96)
  buf.writeUInt32LE(0x1000, dd + 8) // import table RVA (inside the section)
  buf.writeUInt32LE(0x200, dd + 12) // import table size (loose — the parser bounds itself)
  const sec = opt + optSize
  buf.writeUInt32LE(0x400, sec + 8) // virtualSize
  buf.writeUInt32LE(0x1000, sec + 12) // virtualAddress
  buf.writeUInt32LE(0x400, sec + 16) // sizeOfRawData
  buf.writeUInt32LE(0x400, sec + 20) // pointerToRawData

  let desc = 0x400 // RVA 0x1000 → file 0x400
  let nameRva = 0x1100
  for (const dll of dllNames) {
    buf.writeUInt32LE(nameRva, desc + 12) // Name
    buf.writeUInt32LE(nameRva, desc + 16) // FirstThunk
    buf.write(dll + "\0", 0x400 + (nameRva - 0x1000), "latin1")
    nameRva += 0x40
    desc += 20
  }
  return buf
}

describe("importsMsysCygwin (pure PE parse)", () => {
  it("detects msys-2.0.dll in a PE32 import table", () => {
    expect(importsMsysCygwin(buildPe(["kernel32.dll", "msys-2.0.dll", "ntdll.dll"]))).toBe(true)
  })

  it("detects cygwin1.dll in a PE32+ import table", () => {
    expect(importsMsysCygwin(buildPe(["cygwin1.dll"], { pe32Plus: true }))).toBe(true)
  })

  it("is case-insensitive on the DLL name", () => {
    expect(importsMsysCygwin(buildPe(["MSYS-2.0.DLL"]))).toBe(true)
  })

  it("does not flag ordinary Windows binaries", () => {
    expect(importsMsysCygwin(buildPe(["kernel32.dll", "advapi32.dll", "ws2_32.dll"]))).toBe(false)
    expect(importsMsysCygwin(buildPe([]))).toBe(false)
  })

  it("rejects non-PE content, emptiness, and truncation instead of throwing", () => {
    expect(importsMsysCygwin(Buffer.from("#!/bin/sh\necho hi\n", "latin1"))).toBe(false)
    expect(importsMsysCygwin(Buffer.alloc(0))).toBe(false)

    const oob = Buffer.alloc(0x80)
    oob.write("MZ", 0, "latin1")
    oob.writeUInt32LE(0xffffff00, 0x3c) // e_lfanew past the buffer
    expect(importsMsysCygwin(oob)).toBe(false)

    const notPe = Buffer.alloc(0x80)
    notPe.write("MZ", 0, "latin1")
    notPe.writeUInt32LE(0x40, 0x3c)
    notPe.write("NOTPE", 0x40, "latin1")
    expect(importsMsysCygwin(notPe)).toBe(false)

    // A header claiming an import table whose RVA maps to no section.
    const unmapped = buildPe(["msys-2.0.dll"])
    unmapped.writeUInt32LE(0x99999, 0xf8 + 8) // import RVA → nowhere
    expect(importsMsysCygwin(unmapped)).toBe(false)
  })

  it("reports false for an import-table RVA of zero (no imports)", () => {
    const noImports = buildPe(["msys-2.0.dll"])
    noImports.writeUInt32LE(0, 0xf8 + 8)
    expect(importsMsysCygwin(noImports)).toBe(false)
  })
})

describe("binaryImportsMsysCygwin (file half)", () => {
  it("never throws on paths that are not readable binaries", () => {
    expect(binaryImportsMsysCygwin(path.join(os.tmpdir(), "definitely-not-here-xyz.exe"))).toBe(false)
    expect(binaryImportsMsysCygwin(os.tmpdir())).toBe(false) // a directory
    expect(binaryImportsMsysCygwin("")).toBe(false)
  })

  it("does not flag the node runtime", () => {
    expect(binaryImportsMsysCygwin(process.execPath)).toBe(false)
  })

  it("flags the real MSYS bash and not Git's dispatcher stub", () => {
    if (!HAVE_GIT_BASH) return // Windows host without Git for Windows — nothing to scan
    const stat = fs.statSync(GIT_REAL_BASH)
    expect(stat.size).toBeLessThanOrEqual(MAX_PE_SCAN_BYTES)
    expect(binaryImportsMsysCygwin(GIT_REAL_BASH)).toBe(true)
    // The stub imports only KERNEL32/msvcrt/SHELL32 — statically clean, yet
    // its child dies under the container. That launcher-chain gap is what
    // bash.ts's session probe exists for; this layer must not guess.
    expect(binaryImportsMsysCygwin(GIT_STUB_BASH)).toBe(false)
  })
})

describe("resolveExecutable", () => {
  it("keeps absolute paths that exist and drops ones that do not", () => {
    expect(resolveExecutable(process.execPath, process.cwd())).toBe(process.execPath)
    expect(resolveExecutable(path.join(os.tmpdir(), "no-such-binary-xyz"), process.cwd())).toBeUndefined()
  })

  it("resolves relative paths against the spawn cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemo-resolve-"))
    try {
      fs.mkdirSync(path.join(dir, "sub"))
      fs.writeFileSync(path.join(dir, "sub", "thing"), "x")
      expect(resolveExecutable(path.join("sub", "thing"), dir)).toBe(path.join(dir, "sub", "thing"))
      expect(resolveExecutable(path.join("sub", "missing"), dir)).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resolves bare names through PATH (PATHEXT on Windows)", () => {
    const savedPath = process.env.PATH
    try {
      const dir = path.dirname(process.execPath)
      const stem = path.basename(process.execPath, path.extname(process.execPath))
      process.env.PATH = dir
      const resolved = resolveExecutable(stem, process.cwd())
      expect(resolved).toBeDefined()
      expect(fs.existsSync(resolved as string)).toBe(true)
      expect(resolveExecutable("definitely-not-a-real-bin-xyz", process.cwd())).toBeUndefined()
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }
  })

  it("accepts empty input", () => {
    expect(resolveExecutable("", process.cwd())).toBeUndefined()
  })
})

describe("acWorkloadIncompatible", () => {
  it("is false for the node runtime and for names nothing can resolve", () => {
    expect(acWorkloadIncompatible(process.execPath, process.cwd())).toBe(false)
    expect(acWorkloadIncompatible("definitely-not-a-real-bin-xyz", process.cwd())).toBe(false)
  })

  it("is true for a directly-referenced MSYS shell, false for the stub", () => {
    if (!HAVE_GIT_BASH) return
    expect(acWorkloadIncompatible(GIT_REAL_BASH, process.cwd())).toBe(true)
    expect(acWorkloadIncompatible(GIT_STUB_BASH, process.cwd())).toBe(false)
  })
})

/**
 * The regression for the reported bug at the spawn layer: with the
 * infrastructure probe passing (the user's machine), an AppContainer
 * spawn of a *directly referenced* MSYS shell must NOT be attempted — it
 * is downgraded to an honest policy-only run that executes, and the
 * child's sandbox-metadata stamps must not claim isolation that was not
 * applied. (The default shell's dispatcher-stub chain is covered by the
 * bash.ts session-probe tests in bash-sandbox.test.ts.)
 */
describe.runIf(HAVE_GIT_BASH)("spawnProcess vs an MSYS shell", () => {
  afterEach(() => {
    setWindowsAcProbeForTests(null)
  })

  it("downgrades the AppContainer spawn to a working policy-only run", async () => {
    setWindowsAcProbeForTests(() => true) // infra probe passes, as on the user's machine
    const request: SpawnRequest = {
      command: [
        GIT_REAL_BASH,
        "-c",
        'pwd; echo stamp=$NEMO_SANDBOX; echo net=${NEMO_SANDBOX_NETWORK_DISABLED:-dropped}',
      ],
      cwd: process.cwd(),
      sandboxType: SandboxType.WindowsRestrictedToken,
      env: {
        ...process.env,
        NEMO_SANDBOX: "windows_sandbox",
        NEMO_SANDBOX_NETWORK_DISABLED: "true",
      } as Record<string, string>,
      networkPolicy: { disableNetwork: true, allowedDomains: [], blockedDomains: [] },
      filesystemPolicy: {
        writableRoots: [process.cwd()],
        readOnlySubpaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
      },
      outputCap: 65_536,
      timeoutMs: 60_000,
    }

    const proc = await spawnProcess(request)
    expect(proc.isSandboxed).toBe(false)
    expect(proc.sandboxType).toBe(SandboxType.None)
    expect(proc.fallbackReason).toContain("msys/cygwin")

    const out = await proc.readAll()
    const code = await proc.waitForExit()
    // Before the fix this was 3221225794 (0xC0000142) with a fatal error
    // on stderr and no command output at all.
    expect(code).toBe(0)
    expect(out).toContain("stamp=policy-only") // no claim of windows_sandbox
    expect(out).toContain("net=dropped") // no claim of network isolation either
  }, 60_000)
})
