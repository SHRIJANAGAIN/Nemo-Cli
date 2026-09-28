/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

// The Ink REPL (packages/tui/src/ink-app) is the one and only interactive UI
// for Trayambak. The legacy TerminalUI has been removed from this path.

import * as http from "http"
import { spawn } from "node:child_process"
import path from "node:path"
import { loadConfig, type TrayambakConfig } from "../../../runtime/src/index.js"
import { slashCommandService } from "./slash-command.js"

export interface RunOptions {
  config: TrayambakConfig
  prompt?: string
  sessionFile?: string
  sessionId?: string
  modelPath?: string
  port?: number
  useInk?: boolean
}

export const NVIDIA_STATIC_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/llama-3.3-70b-instruct",
  "nvidia/llama-3.1-405b-instruct",
  "nvidia/mixtral-8x7b-instruct",
  "nvidia/qwen-2.5-72b-instruct",
  "nvidia/gemma-2-9b-instruct",
  "nvidia/gemma-2-27b-instruct",
]

export function listModelNames(baseUrl: string, apiKey: string, provider?: string): Promise<string[]> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      resolve(NVIDIA_STATIC_MODELS)
      return
    }
    const isHttps = parsed.protocol === "https:"
    // Dynamic import avoids a top-level https import churn; require is fine in CJS.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = isHttps ? require("https") : http
    const prov = (provider ?? "").toLowerCase()
    let reqPath = "/v1/models"
    const headers: Record<string, string> = {}
    if (prov === "anthropic") {
      if (apiKey) headers["x-api-key"] = apiKey
      headers["anthropic-version"] = "2023-06-01"
    } else if (prov === "ollama") {
      // Ollama-native list (VS Code ollamaProvider: GET {url}/api/tags).
      reqPath = "/api/tags"
    } else if (prov === "google") {
      reqPath = apiKey ? `/models?key=${encodeURIComponent(apiKey)}` : "/models"
    } else if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`
    }
    // Google baseUrl already contains /v1beta — keep it; others strip trailing /.
    const prefix = prov === "google" ? parsed.pathname.replace(/\/$/, "") : ""
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${prefix}${reqPath}`,
        method: "GET",
        timeout: 10_000,
        headers,
      },
      (res: { on: (ev: string, cb: (c?: string) => void) => void }) => {
        let buf = ""
        res.on("data", (c) => (buf += c))
        res.on("end", () => {
          try {
            const json = JSON.parse(buf) as {
              data?: Array<{ id?: string }>
              models?: Array<{ name?: string }>
            }
            if (prov === "google") {
              const ids = (json.models ?? [])
                .map((m) => (m.name ?? "").replace(/^models\//, ""))
                .filter((v) => v.length > 0)
              resolve(ids.length > 0 ? ids : NVIDIA_STATIC_MODELS)
              return
            }
            if (prov === "ollama") {
              const tags = (json as { models?: Array<{ name?: string; model?: string }> }).models ?? []
              const ids = tags.map((m) => m.name ?? m.model ?? "").filter((v) => v.length > 0)
              resolve(ids.length > 0 ? ids : NVIDIA_STATIC_MODELS)
              return
            }
            const ids = (json.data ?? [])
              .map((m: { id?: string }) => m.id)
              .filter((v): v is string => typeof v === "string" && v.length > 0)
            resolve(ids.length > 0 ? ids : NVIDIA_STATIC_MODELS)
          } catch {
            resolve(NVIDIA_STATIC_MODELS)
          }
        })
      },
    )
    req.on("error", () => resolve(NVIDIA_STATIC_MODELS))
    req.end()
  })
}

/** Launch the Ink REPL — the single main UI for Trayambak. */
export async function runCommand(options: RunOptions): Promise<void> {
  const inkLauncher = path.resolve(__dirname, "../../../../packages/tui/src/repl/ink-repl.mjs")

  // Config resolution: explicit options win, then fall back to the persisted
  // config file, then to environment variables. Never hand the TUI an
  // undefined config — it would crash on `config.baseUrl`.
  const resolved: TrayambakConfig = {
    ...loadConfig(),
    ...options.config,
  }

  await new Promise<void>((resolve, reject) => {
    // Silence Node's MODULE_TYPELESS_PACKAGE_JSON reparse warning (emitted
    // when importing user .ts tool files that have no package.json "type") —
    // raw stderr would tear through the TUI frame. Gated: older Node rejects
    // unknown flags at startup, and it is only an aesthetics concern there.
    const nodeArgs = process.allowedNodeEnvironmentFlags.has("--disable-warning")
      ? ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", inkLauncher]
      : [inkLauncher]
    const child = spawn(process.execPath, nodeArgs, {
      env: {
        ...process.env,
        TRAYAMBAK_CONFIG_JSON: JSON.stringify(resolved),
        TRAYAMBAK_MODEL: resolved.model ?? "",
        TRAYAMBAK_BASE_URL: resolved.baseUrl ?? "",
        TRAYAMBAK_API_KEY: resolved.apiKey ?? "",
        TRAYAMBAK_PROMPT: options.prompt ?? "",
        TRAYAMBAK_SESSION: options.sessionFile ?? "",
        TRAYAMBAK_SESSION_ID: options.sessionId ?? "",
        TRAYAMBAK_MODEL_PATH: options.modelPath ?? "",
        TRAYAMBAK_PORT: options.port != null ? String(options.port) : "",
      },
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) {
        // Ctrl+C / SIGTERM from inside the TUI — treat as a clean exit.
        resolve()
        return
      }
      if (code !== 0) {
        reject(new Error(`Ink REPL exited with code ${code ?? "unknown"}`))
        return
      }
      resolve()
    })
  })
}

export async function handleSlashCommand(input: string): Promise<string> {
  return slashCommandService.dispatch(input)
}

export function getSlashHelp(): string {
  return slashCommandService.help()
}
