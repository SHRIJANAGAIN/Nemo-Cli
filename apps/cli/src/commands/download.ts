/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * `trayambak download` — fetch a GGUF model from Hugging Face.
 *
 * Supply-chain rules (#67):
 *   - Every hop (initial URL and each redirect) must be an allowlisted
 *     Hugging Face host; redirects are capped at 5 and must be https.
 *     Plain http is selectable for loopback hosts only, which exists so the
 *     test suite can exercise this code against local servers — the
 *     production allowlist contains no loopback name, so a production hop
 *     can never be plain http.
 *   - The HF token rides only hops that stay on the host it was sent to; a
 *     cross-host redirect drops the `Authorization` header, so a hostile
 *     302 cannot exfiltrate `HF_TOKEN`.
 *   - When HF publishes an LFS sha256 (`x-linked-etag`/`etag`), the written
 *     file is hashed after download and removed on mismatch — a model that
 *     lands in `modelPath` config is never silently unverified.
 *   - Repository ids and file paths are validated before entering a URL.
 */

import { createHash } from "crypto"
import * as fs from "fs"
import * as http from "http"
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

/** Base domains: exact match or any subdomain (`cdn-lfs.huggingface.co`). */
const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["huggingface.co", "hf.co"]

const MAX_REDIRECTS = 5

/** Loopback check — http to these hosts is admitted only when an allowlist
 *  includes them (test servers). The production allowlist contains no
 *  loopback name, so a production hop is always https. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  )
}

/** True when `hostname` is `base` or a subdomain of any `allowed` base. */
export function isAllowedDownloadHost(hostname: string, allowed: readonly string[] = DEFAULT_ALLOWED_HOSTS): boolean {
  const host = hostname.toLowerCase()
  return allowed.some((base) => host === base || host.endsWith(`.${base}`))
}

/** Validate one hop's URL: allowlisted host, https (loopback http excepted). */
function assertHopUrl(raw: string, allowed: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("Download redirect is not a valid URL — refusing.")
  }
  if (!isAllowedDownloadHost(url.hostname, allowed)) {
    throw new Error(`Refusing download redirect to "${url.hostname}" — not an allowlisted Hugging Face host.`)
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`Refusing non-HTTPS download URL for "${url.hostname}".`)
  }
  return url
}

/** First sha256-shaped value among HF's integrity headers, if any.
 *  LFS oids are 64 hex chars; non-LFS etags (40-hex git blob shas) never
 *  match, so an absent header simply means "nothing to verify". */
function headerSha(headers: http.IncomingHttpHeaders): string | undefined {
  for (const name of ["x-linked-etag", "etag", "x-linked-sha256"]) {
    const raw = headers[name]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) continue
    const cleaned = value.trim().replace(/^W\//, "").replace(/"/g, "")
    if (/^[0-9a-f]{64}$/i.test(cleaned)) return cleaned.toLowerCase()
  }
  return undefined
}

/** Streaming sha256 — models reach multi-GB, never buffer them. */
function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = fs.createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
    stream.on("error", reject)
  })
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
          const status = response.statusCode ?? 500
          if (status >= 300 && status < 400) {
            // https.get never follows redirects — report one instead of
            // JSON-parsing its body. The URL is host-fixed and validated.
            reject(new Error(`Hugging Face returned HTTP ${status} redirect for model metadata.`))
            return
          }
          if (status >= 400) {
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

interface HopState {
  redirects: number
  expectedSha?: string
}

export interface DownloadOptions {
  /** Redirect target hostnames (default: the Hugging Face domains). */
  allowedHosts?: readonly string[]
}

/**
 * Download `url` to `destination`, following at most `MAX_REDIRECTS`
 * allowlisted https redirects. Resolves only after the integrity header
 * (when present) matched the bytes on disk; removes the file on mismatch.
 */
export function downloadFile(url: string, destination: string, token?: string, opts?: DownloadOptions): Promise<void> {
  return downloadHop(url, destination, token, opts?.allowedHosts ?? DEFAULT_ALLOWED_HOSTS, { redirects: 0 })
}

function downloadHop(
  url: string,
  destination: string,
  token: string | undefined,
  allowed: readonly string[],
  state: HopState,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let target: URL
    try {
      target = assertHopUrl(url, allowed)
    } catch (error) {
      reject(error)
      return
    }
    // assertHopUrl only admits https, except loopback (test servers).
    const get: typeof https.get = target.protocol === "https:" ? https.get : (http.get as typeof https.get)
    const request = get(
      target,
      {
        headers: {
          "User-Agent": "trayambak",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (response) => {
        const sha = headerSha(response.headers)
        if (sha && state.expectedSha === undefined) state.expectedSha = sha
        const status = response.statusCode ?? 500

        if (status >= 300 && status < 400) {
          response.resume()
          const location = response.headers.location
          if (!location) {
            reject(new Error(`Hugging Face returned HTTP ${status} redirect without a location.`))
            return
          }
          if (state.redirects >= MAX_REDIRECTS) {
            reject(new Error(`Too many redirects (limit ${MAX_REDIRECTS}) — refusing.`))
            return
          }
          state.redirects += 1
          let next: URL
          try {
            next = new URL(location, target)
          } catch {
            reject(new Error("Hugging Face returned an invalid redirect location."))
            return
          }
          // Cross-host redirects drop the token (#67): a hostile 302 can
          // point anywhere allowlisted but never learn HF_TOKEN.
          const nextToken = next.hostname === target.hostname ? token : undefined
          downloadHop(next.toString(), destination, nextToken, allowed, state).then(resolve, reject)
          return
        }
        if (status >= 400) {
          response.resume()
          reject(new Error(`Hugging Face download failed with HTTP ${status}.`))
          return
        }

        const file = fs.createWriteStream(destination)
        let settled = false
        const fail = (error: unknown): void => {
          if (settled) return
          settled = true
          file.destroy()
          try {
            fs.unlinkSync(destination)
          } catch {
            /* partial file may not exist yet */
          }
          reject(error instanceof Error ? error : new Error(String(error)))
        }
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
        file.on("error", fail)
        response.on("error", fail)
        file.on("finish", () => {
          file.close(() => {
            if (settled) return
            const expected = state.expectedSha
            if (!expected) {
              settled = true
              process.stdout.write(total > 0 ? "\n" : "Download complete.\n")
              resolve()
              return
            }
            sha256File(destination).then(
              (actual) => {
                if (actual !== expected) {
                  try {
                    fs.unlinkSync(destination)
                  } catch {
                    /* already gone */
                  }
                  settled = true
                  reject(
                    new Error(
                      `Integrity check failed for ${path.basename(destination)}: ` +
                        `expected sha256 ${expected}, got ${actual}. File removed.`,
                    ),
                  )
                  return
                }
                settled = true
                process.stdout.write(total > 0 ? "\n" : "Download complete.\n")
                resolve()
              },
              (error: unknown) => fail(error),
            )
          })
        })
      },
    )
    request.on("error", (error) => reject(error))
    request.setTimeout(30_000, () => request.destroy(new Error("Hugging Face download timed out.")))
  })
}

/**
 * Repository ids are interpolated into HF URLs — accept only `name` or
 * `namespace/name` from a conservative charset before they enter a URL (#67).
 */
export function assertHfRepoId(repo: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(repo)) {
    throw new Error(`Invalid Hugging Face repository id "${repo}" (expected "model" or "namespace/model").`)
  }
  return repo
}

/** Same rule for file paths: safe charset, no `..` traversal segments (#67). */
export function assertHfFileArg(file: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file) || file.includes("..")) {
    throw new Error(`Invalid file path "${file}" (letters, digits, ".", "_", "-", "/" only, no "..").`)
  }
  return file
}

export async function downloadCommand(args: string[]): Promise<void> {
  const repoArg = args[0]
  const requestedFile = args[1]
  const outputIndex = args.indexOf("--output")
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined
  if (!repoArg || repoArg.startsWith("-")) {
    process.stdout.write("Usage: trayambak download <org/model> [file.gguf] [--output <path>]\n")
    return
  }
  const repo = assertHfRepoId(repoArg)

  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN
  const metadata = requestedFile ? undefined : await requestJson(`https://huggingface.co/api/models/${repo}`, token)
  const file = requestedFile ?? chooseGguf(metadata?.siblings ?? [])
  if (!file) {
    throw new Error(`No GGUF file found in Hugging Face repository ${repo}. Specify the filename explicitly.`)
  }
  // HF's metadata rfilename values get the same rule as user input (#67).
  assertHfFileArg(file)

  const destination = path.resolve(output ?? path.join(process.cwd(), path.basename(file)))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  process.stdout.write(`Importing ${repo}/${file} from Hugging Face\n`)
  await downloadFile(`https://huggingface.co/${repo}/resolve/main/${file}`, destination, token)
  saveConfig({ modelPath: destination })
  process.stdout.write(`Model saved to ${destination}\n`)
  process.stdout.write("Next run will auto-start llama.cpp with this model.\n")
}
