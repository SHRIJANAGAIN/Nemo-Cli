/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { execFileSync, spawn, type ChildProcess } from "child_process"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { loadConfig } from "../../../runtime/src/index"
import { ensureLlamaCppBin, locateLlamaCppBin } from "../../../runtime/src/llama-cpp-bin"
import { envInt, envPathList, envString } from "../../../../packages/core/src/env_read.js"

function logStream(): number | "pipe" {
  const dir = path.join(os.homedir(), ".nemo", "logs")
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "llama-server.log")
  return fs.openSync(file, "a")
}

function detectGpuLayers(): number {
  // envInt, not `Number(process.env.X)`: the old spelling returned NaN for a junk
  // value, and the result went straight onto the llama-server command line as
  // `--n-gpu-layers NaN` — a value the server cannot parse, so the model never
  // loaded and the error pointed at the binary rather than at the typo.
  const configured = envInt("NEMO_GPU_LAYERS", undefined)
  if (configured !== undefined) return Math.max(0, configured)
  const probes: Array<[string, string[]]> = [
    ["nvidia-smi", ["-L"]],
    ["rocminfo", []],
  ]
  for (const [command, args] of probes) {
    try {
      const output = execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      })
      if (output.trim()) return -1
    } catch {
      // Probe failures mean this accelerator is unavailable.
    }
  }
  return 0
}

export interface ServeOptions {
  model?: string
  port?: number
  ctxSize?: number
  gpuLayers?: number
  batchSize?: number
  ubatchSize?: number
}

/** Locate an already-available llama.cpp server binary (no download). */
export function resolveLlamaCppBin(): string | null {
  return locateLlamaCppBin()
}

/** Detect whether the machine has a GPU AND whether the bundled llama.cpp build
 *  was compiled with a GPU backend (CUDA / Vulkan / D3D). A CPU-only build
 *  silently ignores --n-gpu-layers, which is why offload sometimes seems dead. */
export function detectGpuBackend(): { gpuDetected: boolean; binarySupportsGpu: boolean; backend?: string } {
  const gpuDetected = detectGpuLayers() !== 0
  const bin = locateLlamaCppBin()
  let backend: string | undefined
  let binarySupportsGpu = false
  if (bin) {
    try {
      for (const f of fs.readdirSync(path.dirname(bin))) {
        if (/(^|[^a-z])cuda/i.test(f)) {
          backend = "CUDA"
          break
        }
        if (/(^|[^a-z])vulkan/i.test(f)) {
          backend = "Vulkan"
          break
        }
        if (/(^|[^a-z])d3d/i.test(f)) {
          backend = "D3D"
          break
        }
      }
    } catch {
      /* ignore */
    }
    binarySupportsGpu = !!backend
  }
  return { gpuDetected, binarySupportsGpu, backend }
}

/** Pick a free ephemeral TCP port (used for the hidden internal server). */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      resolve(typeof addr === "object" && addr ? addr.port : 0)
      srv.close()
    })
  })
}

/** Start a llama.cpp server as a child process. Silent: nothing printed, hidden port. */
export async function launchServer(options: ServeOptions): Promise<ChildProcess | null> {
  const cfg = loadConfig()
  const bin = await ensureLlamaCppBin()
  if (!bin) return null

  const model = options.model ?? cfg.modelPath ?? envString("NEMO_MODEL_PATH")
  if (!model) return null

  const port = options.port ?? (await getFreePort()) ?? 8080
  // Same NaN-to-argv hazard as the GPU layers above: a junk override used to put
  // a literal "NaN" in --ctx-size / --batch-size / --ubatch-size.
  const ctxSize = options.ctxSize ?? envInt("NEMO_CTX_SIZE", cfg.ctxSize ?? 16384) ?? 16384
  const batchSize = options.batchSize ?? envInt("NEMO_BATCH_SIZE", cfg.batchSize ?? 256) ?? 256
  const ubatchSize = options.ubatchSize ?? envInt("NEMO_UBATCH_SIZE", cfg.ubatchSize ?? 128) ?? 128
  const args = ["--model", model, "--port", String(port)]
  args.push("--ctx-size", String(ctxSize))
  args.push("--parallel", "1")
  args.push("--n-gpu-layers", String(options.gpuLayers ?? detectGpuLayers()))
  args.push("--batch-size", String(batchSize))
  args.push("--ubatch-size", String(ubatchSize))
  // mmap keeps model weights out of committed RAM (streams from disk on demand),
  // which is essential when free memory is tight.
  args.push("--mmap")

  const binDir = path.dirname(bin)
  const child = spawn(bin, args, {
    stdio: ["ignore", logStream(), logStream()],
    windowsHide: true,
    cwd: binDir,
    // envPathList drops empty segments and joins with the platform separator, so an
    // unset/blank PATH no longer contributes a trailing empty entry that Windows
    // resolves against the current directory.
    env: { ...process.env, PATH: [binDir, ...envPathList("PATH")].join(path.delimiter) },
  })
  return child
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const child = await launchServer(options)
  if (!child) {
    process.stdout.write(
      [
        "No llama.cpp server binary found and it could not be downloaded automatically.",
        "Set NEMO_LLAMACPP_BIN to a prebuilt 'server.exe' / 'llama-server' from llama.cpp, for example:",
        "  set NEMO_LLAMACPP_BIN=C:\\path\\to\\llama-server.exe",
        "Then run: nemo serve --model /path/to/model.gguf --port 8080",
        "",
        "Or start llama.cpp yourself and point nemo at it:",
        `  nemo config set baseUrl http://localhost:${options.port ?? 8080}`,
      ].join("\n") + "\n",
    )
    return
  }

  const shutdown = (): void => {
    child.kill("SIGTERM")
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  child.on("exit", (code) => {
    process.off("SIGINT", shutdown)
    process.off("SIGTERM", shutdown)
    process.exit(code ?? 0)
  })
}
