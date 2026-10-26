/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * AppContainer workload compatibility — can this binary even start inside
 * the Windows sandbox?
 *
 * The MSYS/Cygwin runtimes die at process-init inside an AppContainer: the
 * AC object namespace denies the write their DllMain performs
 * (`NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-…)` →
 * STATUS_ACCESS_DENIED `0xC0000022`) and the process exits before `main`
 * with STATUS_DLL_INIT_FAILED `0xC0000142`. Git-bash — the shell
 * `detectDefaultShell()` prefers on Windows — is exactly such a binary, so
 * engaging the container for it fails *every* bash run with a cryptic fatal
 * error the user can do nothing about (observed live: `bash bug` report,
 * exit code 3221225794 before `pwd` printed anything).
 *
 * The runtime is a static property of the image: it appears in the PE
 * import table, the same list the loader uses — so the verdict cannot be
 * spoofed by a filename or by strings merely embedded in resources, and a
 * binary that really does import the runtime genuinely dies under the
 * container. The verdict downgrades the spawn to the honest policy-only
 * path (spawn.ts rewrites the child's sandbox-metadata stamps with it);
 * binaries we cannot read, do not find, or that are not PE at all report
 * `false` and keep the status quo — the container still decides for itself.
 */

import * as fs from "fs"
import * as path from "path"

/** Read cap for the import-table scan — shells are KB/MB, not hundreds of MB. */
export const MAX_PE_SCAN_BYTES = 8 * 1024 * 1024

/** Runtimes whose DllMain cannot run under AppContainer isolation. */
const INCOMPATIBLE_RUNTIME_DLL = /^(?:msys-[\w.-]*\.dll|cygwin\d*\.dll)$/i

const MZ = 0x5a4d
const PE32 = 0x10b
const PE32_PLUS = 0x20b
const MAX_SECTIONS = 96
const MAX_IMPORT_DESCRIPTORS = 512
const IMPORT_DESCRIPTOR_BYTES = 20
const SECTION_HEADER_BYTES = 40

/**
 * True when a PE image imports an MSYS/Cygwin runtime DLL.
 *
 * Pure and defensive: malformed, truncated, or non-PE buffers report
 * `false` (the spawn keeps the container) instead of throwing — parsing
 * runs on caller-chosen binaries and a parser crash must never take down
 * the spawner.
 */
export function importsMsysCygwin(buf: Buffer): boolean {
  try {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== MZ) return false
    const pe = buf.readUInt32LE(0x3c)
    if (pe + 24 > buf.length) return false
    if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") return false

    const coff = pe + 4
    const numSections = buf.readUInt16LE(coff + 2)
    const optSize = buf.readUInt16LE(coff + 16)
    const opt = coff + 20
    if (numSections === 0 || numSections > MAX_SECTIONS) return false
    if (optSize < 2 || opt + optSize > buf.length) return false

    const magic = buf.readUInt16LE(opt)
    if (magic !== PE32 && magic !== PE32_PLUS) return false

    // Data directory[1] = import table; the array starts at 96 (PE32) or
    // 112 (PE32+) bytes into the optional header.
    const dd = magic === PE32 ? opt + 96 : opt + 112
    if (dd + 16 > opt + optSize) return false
    const importRva = buf.readUInt32LE(dd + 8)
    if (importRva === 0) return false

    const sizeOfHeaders = buf.readUInt32LE(opt + 60) // SizeOfHeaders (NOT +56: that is SizeOfImage)
    const sectionTable = opt + optSize

    const rvaToOffset = (rva: number): number | undefined => {
      if (rva < sizeOfHeaders) return rva < buf.length ? rva : undefined
      for (let i = 0; i < numSections; i++) {
        const s = sectionTable + i * SECTION_HEADER_BYTES
        if (s + SECTION_HEADER_BYTES > buf.length) return undefined
        const virtualSize = buf.readUInt32LE(s + 8)
        const virtualAddress = buf.readUInt32LE(s + 12)
        const rawSize = buf.readUInt32LE(s + 16)
        const rawPointer = buf.readUInt32LE(s + 20)
        if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
          const off = rawPointer + (rva - virtualAddress)
          return off < buf.length ? off : undefined
        }
      }
      return undefined
    }

    const descOffset = rvaToOffset(importRva)
    if (descOffset === undefined) return false
    for (let i = 0; i < MAX_IMPORT_DESCRIPTORS; i++) {
      const d = descOffset + i * IMPORT_DESCRIPTOR_BYTES
      if (d + IMPORT_DESCRIPTOR_BYTES > buf.length) return false
      const nameRva = buf.readUInt32LE(d + 12)
      const firstThunk = buf.readUInt32LE(d + 16)
      if (nameRva === 0 && firstThunk === 0) break // all-zero descriptor terminates
      if (nameRva === 0) continue
      const nameOffset = rvaToOffset(nameRva)
      if (nameOffset === undefined || nameOffset >= buf.length) continue
      const end = buf.indexOf(0, nameOffset)
      if (end < 0 || end - nameOffset > 255) continue
      if (INCOMPATIBLE_RUNTIME_DLL.test(buf.toString("latin1", nameOffset, end))) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * File-system half: size-cap, read, and parse. Never throws; anything
 * unreadable, oversized, or non-PE reports `false`.
 */
export function binaryImportsMsysCygwin(file: string): boolean {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_PE_SCAN_BYTES) return false
    return importsMsysCygwin(fs.readFileSync(file))
  } catch {
    return false
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve argv[0] the way the OS would: absolute/relative paths against
 * `cwd`, then PATH — with PATHEXT appended on Windows for extension-less
 * names (`cmd` → `C:\Windows\System32\cmd.exe`). Unresolvable names report
 * `undefined` and leave the spawn decision to the container itself.
 */
export function resolveExecutable(bin: string, cwd: string): string | undefined {
  if (!bin) return undefined
  try {
    if (bin.includes("/") || bin.includes("\\")) {
      const abs = path.isAbsolute(bin) ? bin : path.resolve(cwd, bin)
      return isFile(abs) ? abs : undefined
    }
    const exts =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.COM;.BAT;.CMD")
            .split(";")
            .filter((ext) => ext.length > 0)
        : []
    const hasExt = path.extname(bin).length > 0
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue
      const base = path.join(dir, bin)
      if (isFile(base)) return base
      if (hasExt) continue
      for (const ext of exts) {
        if (isFile(base + ext)) return base + ext
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The single call spawn.ts makes before engaging the AppContainer: true
 * when spawning this argv[0] under AC would die before executing anything.
 */
export function acWorkloadIncompatible(command0: string, cwd: string): boolean {
  const resolved = resolveExecutable(command0, cwd)
  return resolved !== undefined && binaryImportsMsysCygwin(resolved)
}
