/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as http from "http"
import * as https from "https"
import * as url from "url"
import * as os from "os"
import { execFileSync } from "child_process"
import { loadConfig } from "../../../runtime/src/index"
import { listModelNames, NVIDIA_STATIC_MODELS } from "./run"

interface HubResult {
  id?: string
  downloads?: number
  likes?: number
}

function deviceProfile(): { ramGb: number; gpu: boolean } {
  let gpu = false
  try {
    gpu =
      execFileSync("nvidia-smi", ["-L"], {
        encoding: "utf8",
        timeout: 1200,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim().length > 0
  } catch {
    // CPU/RAM fallback is the safe default.
  }
  return { ramGb: Math.floor(os.totalmem() / 1024 / 1024 / 1024), gpu }
}

function localMenu(): void {
  const device = deviceProfile()
  const tier = device.ramGb >= 24 ? "large" : device.ramGb >= 12 ? "medium" : "small"
  const choices = device.gpu
    ? ["TheBloke/DeepSeek-Coder-V2-Lite-Instruct-GGUF", "TheBloke/Qwen2.5-Coder-7B-Instruct-GGUF"]
    : tier === "large"
      ? ["TheBloke/Qwen2.5-Coder-7B-Instruct-GGUF", "TheBloke/DeepSeek-Coder-6.7B-Instruct-GGUF"]
      : ["TheBloke/Qwen2.5-Coder-3B-Instruct-GGUF", "TheBloke/DeepSeek-Coder-1.3B-Instruct-GGUF"]
  process.stdout.write(`Device: ${device.ramGb} GB RAM • ${device.gpu ? "GPU detected" : "CPU/RAM mode"}\n`)
  process.stdout.write("Local-coder recommendations:\n")
  choices.forEach((choice, index) => process.stdout.write(`  ${index + 1}. ${choice}\n`))
  process.stdout.write("\nDownload one with:\n  trayambak download <repo>\n")
}

function searchHub(query: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const endpoint = `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=10`
    https
      .get(endpoint, { headers: { "User-Agent": "trayambak", Accept: "application/json" } }, (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => (body += chunk))
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Hugging Face search failed with HTTP ${res.statusCode}.`))
            return
          }
          const results = JSON.parse(body) as HubResult[]
          if (results.length === 0) process.stdout.write("No GGUF local-coder models found.\n")
          else
            results.forEach((model: { id?: string; downloads?: number }, index: number) =>
              process.stdout.write(`  ${index + 1}. ${model.id ?? "unknown"} (${model.downloads ?? 0} downloads)\n`),
            )
          resolve()
        })
      })
      .on("error", reject)
  })
}

export async function modelsCommand(args: string[] = []): Promise<void> {
  const cfg = loadConfig()
  const provider = cfg.provider ?? "llamacpp"
  if (provider === "nvidia") {
    const models = await listModelNames(cfg.baseUrl, cfg.apiKey)
    const usingFallback = models === NVIDIA_STATIC_MODELS
    if (models.length === 0) {
      process.stdout.write(`No models reported by ${cfg.baseUrl}.\n`)
      process.stdout.write(`Current model: ${cfg.model}\n`)
      process.stdout.write("Use /model <id> in trayambak to switch.\n")
    } else {
      process.stdout.write(usingFallback ? `Available NVIDIA models (offline list):\n` : `Available NVIDIA models:\n`)
      models.forEach((id: string, index: number) => process.stdout.write(`  ${index + 1}. ${id}\n`))
      process.stdout.write(`\nSwitch with: /model <id>\n`)
      if (usingFallback) {
        process.stdout.write(`\n(i) Live catalog unavailable; showing bundled model list.\n`)
      }
    }
    return
  }
  const action = args[0]?.toLowerCase()
  if (action === "--local" || action === "local") {
    localMenu()
    return
  }
  if (action === "--search" || action === "search") {
    await searchHub(args.slice(1).join(" ") || "local coder")
    return
  }
  const base = new url.URL(cfg.baseUrl.replace(/\/+$/, ""))
  const lib = base.protocol === "https:" ? https : http

  const req = lib.request(
    {
      hostname: base.hostname,
      port: base.port || (base.protocol === "https:" ? 443 : 80),
      path: "/v1/models",
      method: "GET",
      timeout: 10_000,
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
    },
    (res) => {
      let buf = ""
      res.on("data", (c) => (buf += c))
      res.on("end", () => {
        try {
          const json = JSON.parse(buf)
          const ids = (json.data ?? []).map((m: { id?: string }) => m.id)
          if (ids.length === 0) process.stdout.write("No models reported by the server.\n")
          else ids.forEach((id: string) => process.stdout.write(`${id}\n`))
        } catch {
          process.stdout.write(`Could not parse server response: ${buf.slice(0, 300)}\n`)
        }
      })
    },
  )
  req.on("error", (err) => process.stdout.write(`Failed to reach ${cfg.baseUrl}: ${err.message}\n`))
  req.end()
}
