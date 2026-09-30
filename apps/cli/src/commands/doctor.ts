/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as http from "http"
import * as https from "https"
import * as os from "os"
import * as path from "path"

declare const __dirname: string
import { loadConfig, type TrayambakConfig } from "../../../runtime/src/index.js"
import { locateLlamaCppBin } from "../../../runtime/src/llama-cpp-bin.js"
import { configPath } from "../../../runtime/src/config.js"

type CheckResult = { name: string; ok: boolean; detail: string }

async function checkServer(baseUrl: string): Promise<CheckResult> {
  const base = baseUrl.replace(/\/+$/, "")
  const url = new URL(base + "/v1/models")
  return new Promise<CheckResult>((resolve) => {
    const lib = url.protocol === "https:" ? https : http
    const defaultPort = url.protocol === "https:" ? 443 : 80
    const req = lib.get(
      { hostname: url.hostname, port: url.port || defaultPort, path: url.pathname, timeout: 3000 },
      (res) => {
        let buf = ""
        res.setEncoding("utf8")
        res.on("data", (c) => (buf += c))
        res.on("end", () => {
          try {
            const json = JSON.parse(buf) as { data?: Array<{ id?: string }> }
            const ids = (json.data ?? []).map((m) => m.id).filter(Boolean)
            resolve({
              name: "Server reachable",
              ok: true,
              detail: `${base} - model(s): ${ids.join(", ") || "none reported"}`,
            })
          } catch {
            resolve({ name: "Server reachable", ok: false, detail: `${base} returned an unparseable response` })
          }
        })
      },
    )
    req.on("error", () => resolve({ name: "Server reachable", ok: false, detail: `${base} - connection failed` }))
    req.on("timeout", () => {
      req.destroy()
      resolve({ name: "Server reachable", ok: false, detail: `${base} - timed out` })
    })
  })
}

export async function doctorCommand(): Promise<void> {
  const results: CheckResult[] = []

  results.push({
    name: "Node",
    ok: Number(process.versions.node.split(".")[0]) >= 18,
    detail: `v${process.versions.node} on ${process.platform}/${process.arch}`,
  })

  const cfg = loadConfig()
  const cfgFile = configPath()
  results.push({
    name: "Config file",
    ok: fs.existsSync(cfgFile),
    detail: fs.existsSync(cfgFile) ? cfgFile : `${cfgFile} (not created yet - defaults apply)`,
  })

  if (cfg.modelPath) {
    results.push({
      name: "GGUF model",
      ok: fs.existsSync(cfg.modelPath),
      detail: fs.existsSync(cfg.modelPath) ? cfg.modelPath : `not found: ${cfg.modelPath}`,
    })
  } else {
    results.push({ name: "GGUF model", ok: true, detail: "not configured (TRAYAMBAK_MODEL_PATH or --model-path)" })
  }

  const bin = locateLlamaCppBin()
  results.push({
    name: "llama.cpp server binary",
    ok: Boolean(bin),
    detail: bin ? bin : "not found - set TRAYAMBAK_LLAMACPP_BIN or run `trayambak serve` to auto-download",
  })

  const server = await checkServer(cfg.baseUrl)
  results.push(server)

  const homeWritable = fs.existsSync(os.homedir())
  results.push({ name: "Home directory", ok: homeWritable, detail: os.homedir() })

  const okCount = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)

  for (const r of results) {
    const color = r.ok ? "\x1b[42m\x1b[37m" : "\x1b[41m\x1b[37m"
    const reset = "\x1b[0m"
    const status = r.ok ? " PASS " : " FAIL "
    process.stdout.write(`${color}${status}${reset} ${r.name}\n`)
  }

  process.stdout.write("\n")
  if (failed.length === 0) {
    process.stdout.write(`\x1b[42m\x1b[37m ${okCount}/${results.length} checks passed \x1b[0m\n`)
  } else {
    process.stdout.write(`\x1b[41m\x1b[37m ${okCount}/${results.length} checks passed \x1b[0m\n`)
    process.stdout.write("\nFailed checks:\n")
    for (const r of failed) {
      process.stdout.write(`  \x1b[31m${r.name}\x1b[0m: ${r.detail}\n`)
    }
  }
  process.stdout.write("\n")
  if (okCount !== results.length) process.exitCode = 1
}

export function infoCommand(): void {
  const cfg = loadConfig() as TrayambakConfig
  const version = readVersion()
  const lines = [
    `trayambak ${version}`,
    `node      v${process.versions.node}`,
    `platform  ${process.platform} ${process.arch}`,
    `cwd       ${process.cwd()}`,
    `baseUrl   ${cfg.baseUrl}`,
    `model     ${cfg.model}`,
    `shell     ${cfg.shellCommand}`,
    `maxTurns  ${cfg.maxTurns}`,
    `tools     ${cfg.nativeTools ? "native function calling" : "text fallback"}`,
  ]
  process.stdout.write(lines.join("\n") + "\n")
}

function readVersion(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "..", "..", "package.json"),
    path.resolve(process.cwd(), "package.json"),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const json = JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string }
        if (json.version) return json.version
      }
    } catch {
      /* keep looking */
    }
  }
  return "0.3.0"
}
