/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as https from "https"
import * as path from "path"
import { saveConfig } from "../../../runtime/src/index.js"

interface HubSibling {
  rfilename?: string
  size?: number
}

interface HubModel {
  siblings?: HubSibling[]
}

function requestJson(url: string, token?: string): Promise<HubModel> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "trayambak",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => (body += chunk))
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Hugging Face returned HTTP ${response.statusCode}: ${body.slice(0, 240)}`))
            return
          }
          try {
            resolve(JSON.parse(body) as HubModel)
          } catch {
            reject(new Error("Hugging Face returned invalid model metadata."))
          }
        })
      },
    )
    request.on("error", reject)
    request.setTimeout(15_000, () => request.destroy(new Error("Hugging Face request timed out.")))
  })
}

function chooseGguf(siblings: HubSibling[]): string | undefined {
  const files = siblings.map((s) => s.rfilename).filter((name): name is string => !!name && /\.gguf$/i.test(name))
  return files.sort((a, b) => {
    const aPreferred = /q4_k_m|q5_k_m/i.test(a) ? 0 : 1
    const bPreferred = /q4_k_m|q5_k_m/i.test(b) ? 0 : 1
    return aPreferred - bPreferred || a.length - b.length
  })[0]
}

function downloadFile(url: string, destination: string, token?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "trayambak",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume()
          downloadFile(response.headers.location, destination, token).then(resolve, reject)
          return
        }
        if ((response.statusCode ?? 500) >= 400) {
          response.resume()
          reject(new Error(`Hugging Face download failed with HTTP ${response.statusCode}.`))
          return
        }
        const file = fs.createWriteStream(destination)
        const total = Number(response.headers["content-length"] ?? 0)
        let received = 0
        response.on("data", (chunk: Buffer) => {
          received += chunk.length
          if (total > 0) {
            const percent = Math.floor((received / total) * 100)
            process.stdout.write(`\rDownloading ${percent}%`)
          }
        })
        response.pipe(file)
        file.on("finish", () =>
          file.close(() => {
            process.stdout.write(total > 0 ? "\n" : "Download complete.\n")
            resolve()
          }),
        )
        file.on("error", reject)
        response.on("error", reject)
      },
    )
    request.on("error", reject)
    request.setTimeout(30_000, () => request.destroy(new Error("Hugging Face download timed out.")))
  })
}

export async function downloadCommand(args: string[]): Promise<void> {
  const repo = args[0]
  const requestedFile = args[1]
  const outputIndex = args.indexOf("--output")
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined
  if (!repo || repo.startsWith("-")) {
    process.stdout.write("Usage: trayambak download <org/model> [file.gguf] [--output <path>]\n")
    return
  }

  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN
  const metadata = requestedFile ? undefined : await requestJson(`https://huggingface.co/api/models/${repo}`, token)
  const file = requestedFile ?? chooseGguf(metadata?.siblings ?? [])
  if (!file) {
    throw new Error(`No GGUF file found in Hugging Face repository ${repo}. Specify the filename explicitly.`)
  }

  const destination = path.resolve(output ?? path.join(process.cwd(), path.basename(file)))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  process.stdout.write(`Importing ${repo}/${file} from Hugging Face\n`)
  await downloadFile(`https://huggingface.co/${repo}/resolve/main/${file}`, destination, token)
  saveConfig({ modelPath: destination })
  process.stdout.write(`Model saved to ${destination}\n`)
  process.stdout.write("Next run will auto-start llama.cpp with this model.\n")
}
