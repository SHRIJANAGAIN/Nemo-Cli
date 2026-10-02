/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as https from "https"
import * as os from "os"
import * as path from "path"

declare const __dirname: string
import { execFile, execFileSync } from "child_process"
import { loadConfig } from "./config.js"

const REPO = "ggml-org/llama.cpp"
const DEFAULT_VERSION = "b10754"
function findProjectRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}
const BIN_DIR = path.join(findProjectRoot(__dirname), "bin")
const CACHE_BIN = path.join(BIN_DIR, "llama-server.exe")
/** GPU (CUDA) build gets its own cache dir so both builds can coexist. */
const GPU_BIN_DIR = path.join(os.homedir(), ".trayambak", "bin-gpu")
const GPU_CACHE_BIN = path.join(GPU_BIN_DIR, "llama-server.exe")

const KNOWN_CANDIDATES = [
  path.join(os.homedir(), "bin", "llama-server.exe"),
  "C:\\Program Files\\llama.cpp\\server.exe",
  "C:\\llama.cpp\\build\\bin\\server.exe",
  "C:\\llama.cpp\\llama-server.exe",
  path.join(os.homedir(), "llama.cpp", "llama-server.exe"),
  path.join(os.homedir(), ".trayambak", "bin", "llama-server.exe"),
  path.join(
    os.homedir(),
    ".lmstudio",
    "extensions",
    "backends",
    "llama.cpp-win-x86_64-nvidia-cuda-avx2-2.25.2",
    "llama-server.exe",
  ),
  path.join(
    os.homedir(),
    ".lmstudio",
    "extensions",
    "backends",
    "llama.cpp-win-x86_64-avx2-2.25.2",
    "llama-server.exe",
  ),
]

/**
 * Newer llama.cpp releases ship a tiny shim exe (~9KB) that loads
 * llama-server-impl.dll from its directory. An exe without its dll (or a
 * corrupted HTML-error-page download) must not be treated as usable.
 */
function usableServerBin(p: string): boolean {
  try {
    const st = fs.statSync(p)
    if (!st.isFile() || st.size < 1024) return false
    // Large standalone exe is fine
    if (st.size > 1024 * 1024) return true
    // Small shim exe is only usable with its impl dll next to it
    return fs.existsSync(path.join(path.dirname(p), "llama-server-impl.dll"))
  } catch {
    return false
  }
}

/** True when an NVIDIA driver is present (i.e. a CUDA build can run). */
export function hasNvidiaGpu(): boolean {
  try {
    execFileSync("nvidia-smi", ["-L"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 })
    return true
  } catch {
    return false
  }
}

/** Synchronously locate an already-available llama.cpp server binary. */
export function locateLlamaCppBin(): string | null {
  // 1) persisted config (set via: trayambak config set llamaCppBin <path>)
  try {
    const cfg = loadConfig()
    if (cfg.llamaCppBin && fs.existsSync(cfg.llamaCppBin)) return cfg.llamaCppBin
  } catch {
    /* ignore */
  }
  // 2) env var
  const fromEnv = process.env.TRAYAMBAK_LLAMACPP_BIN
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  // 3) cached GPU build preferred when an NVIDIA GPU is present
  if (hasNvidiaGpu() && usableServerBin(GPU_CACHE_BIN)) return GPU_CACHE_BIN
  // 4) cached CPU download
  if (usableServerBin(CACHE_BIN)) return CACHE_BIN
  // 5) known install locations
  for (const c of KNOWN_CANDIDATES) {
    if (usableServerBin(c)) return c
  }
  return null
}

/**
 * Ensure a llama.cpp server binary is available. Returns a cached/env/config
 * binary if present, otherwise downloads the official prebuilt Windows (avx2)
 * release. Never throws - returns null on any failure so the caller can print
 * guidance instead of crashing.
 */
export async function ensureLlamaCppBin(): Promise<string | null> {
  const located = locateLlamaCppBin()
  if (located) return located

  const version = process.env.TRAYAMBAK_LLAMACPP_VERSION || DEFAULT_VERSION
  const gpu = hasNvidiaGpu()

  // Preferred variant first (CUDA when an NVIDIA GPU is present, CPU otherwise),
  // then the other one as fallback - both are official prebuilt release zips,
  // nothing is compiled from source.
  const variants: Array<{ kind: "cuda" | "cpu"; dir: string }> = gpu
    ? [
        { kind: "cuda", dir: GPU_BIN_DIR },
        { kind: "cpu", dir: BIN_DIR },
      ]
    : [
        { kind: "cpu", dir: BIN_DIR },
        { kind: "cuda", dir: GPU_BIN_DIR },
      ]

  for (const variant of variants) {
    let url: string | null = null
    try {
      url = await resolveDownloadUrl(version, variant.kind)
    } catch (err) {
      process.stderr.write(
        `Could not resolve llama.cpp ${variant.kind} release: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
    if (!url) continue

    fs.mkdirSync(variant.dir, { recursive: true })
    const zipPath = path.join(variant.dir, "llama.cpp.zip")
    try {
      await downloadFile(url, zipPath)
      await extractZip(zipPath, variant.dir)
      const exe = findServerExe(variant.dir)
      if (exe) {
        process.stdout.write(`Cached llama.cpp ${variant.kind.toUpperCase()} server at ${exe}\n`)
        return exe
      }
    } catch (err) {
      process.stderr.write(
        `Could not fetch llama.cpp ${variant.kind} binary: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }
  return null
}

async function resolveDownloadUrl(version: string, kind: "cuda" | "cpu"): Promise<string | null> {
  if (kind === "cuda") {
    if (version === "latest") {
      return `https://github.com/${REPO}/releases/latest/download/llama-bin-win-cuda-12.4-x64.zip`
    }
    return `https://github.com/${REPO}/releases/download/${version}/llama-${version}-bin-win-cuda-12.4-x64.zip`
  }
  if (version === "latest") {
    return `https://github.com/${REPO}/releases/latest/download/llama-bin-win-cpu-x64.zip`
  }
  return `https://github.com/${REPO}/releases/download/${version}/llama-${version}-bin-win-cpu-x64.zip`
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (u: string): void => {
      const req = https
        .get(u, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            request(res.headers.location)
            return
          }
          if (!res.statusCode || res.statusCode >= 400) {
            res.resume()
            reject(new Error(`download failed: HTTP ${res.statusCode}`))
            return
          }
          const file = fs.createWriteStream(dest)
          res.pipe(file)
          file.on("finish", () => {
            file.close(() => {
              try {
                const buf = fs.readFileSync(dest)
                if (buf.length < 32 || !Buffer.from(buf.slice(0, 4)).toString("hex").startsWith("504b0304")) {
                  reject(new Error("downloaded file is not a valid zip archive"))
                  return
                }
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)))
                return
              }
              resolve()
            })
          })
          file.on("error", reject)
          res.on("error", (err) => {
            file.destroy()
            reject(err)
          })
        })
        .on("error", reject)
      req.setTimeout(120_000, () => req.destroy(new Error("download timeout")))
    }
    request(url)
  })
}

/** PowerShell single-quoted literal: inside `'…'` the only special character
 *  is `'` itself, escaped by doubling. These paths interpolate into
 *  `-Command` source (#80) — `GPU_BIN_DIR` derives from `os.homedir()`, so
 *  an unescaped `'` in the profile path would break out of the string into
 *  executable PowerShell. */
const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** Extract the downloaded llama.cpp release zip. Exported for tests.
 *  Runs non-interactively with a hard timeout so a wedged Expand-Archive
 *  cannot hang ensureLlamaCpp (and whatever awaits it) forever. */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Force -LiteralPath ${psLiteral(zipPath)} -DestinationPath ${psLiteral(destDir)}`,
      ],
      { timeout: 120_000, windowsHide: true },
      (err) => (err ? reject(err) : resolve()),
    )
  })
}

function findServerExe(root: string): string | null {
  let found: string | null = null
  const visit = (dir: string): void => {
    if (found) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) visit(abs)
      else if (/^(llama-server|server)\.exe$/i.test(e.name)) {
        found = abs
        return
      }
    }
  }
  visit(root)
  return found
}
