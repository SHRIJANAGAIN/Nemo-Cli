/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Download supply-chain behaviour (#67): redirect allowlisting, token
 * scoping across hosts, the redirect cap, LFS sha256 integrity, and input
 * validation.
 *
 * Network cases run against local HTTP servers bound to loopback — the code
 * admits plain http for loopback hosts solely so this file can exercise the
 * real request path; the production allowlist contains no loopback name, so
 * production hops are always https on allowlisted Hugging Face domains.
 * Cross-host means `127.0.0.1` vs `127.0.0.2` (both loopback, distinct
 * hostname strings) so no DNS resolution order can flake the test.
 */
import { createHash } from "crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import type { AddressInfo } from "net"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assertHfFileArg, assertHfRepoId, downloadFile, isAllowedDownloadHost } from "./download.js"

interface LocalServer {
  origin: string
  hits: { count: number }
  close(): Promise<void>
}

type Handler = (req: IncomingMessage, res: ServerResponse, server: LocalServer) => void

async function startServer(handler: Handler, host = "127.0.0.1"): Promise<LocalServer> {
  const server = createServer((req, res) => handler(req, res, instance))
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  const port = (server.address() as AddressInfo).port
  const instance: LocalServer = {
    origin: `http://${host}:${port}`,
    hits: { count: 0 },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
  return instance
}

/** Serve a fixed body with an optional LFS-style sha256 header. */
function serveBody(body: string, opts?: { sha?: string; capture?: { auth?: string } }): Handler {
  return (req, res) => {
    if (opts?.capture) opts.capture.auth = req.headers.authorization
    const headers: Record<string, string> = { "content-length": String(Buffer.byteLength(body)) }
    if (opts?.sha) headers["x-linked-etag"] = `"${opts.sha}"`
    res.writeHead(200, headers)
    res.end(body)
  }
}

const ALLOWED = ["127.0.0.1", "127.0.0.2"]
const SECRET = "hf_secret-token"

let home: string
let dest: string
const servers: LocalServer[] = []

async function serve(handler: Handler, host?: string): Promise<LocalServer> {
  const server = await startServer(handler, host)
  servers.push(server)
  return server
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "trayambak-dl-"))
  dest = join(home, "model.gguf")
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  rmSync(home, { recursive: true, force: true })
})

describe("redirect policy and token scoping", () => {
  it("keeps the token on a same-host redirect and still writes the file", async () => {
    const body = "model-bytes"
    const finalCapture: { auth?: string } = {}
    const final = await serve(
      serveBody(body, { sha: createHash("sha256").update(body).digest("hex"), capture: finalCapture }),
    )
    const originCapture: { auth?: string } = {}
    const origin = await serve((req, res) => {
      originCapture.auth = req.headers.authorization
      res.writeHead(302, { location: `${final.origin}/file` })
      res.end()
    })

    await downloadFile(`${origin.origin}/resolve`, dest, SECRET, { allowedHosts: ALLOWED })

    expect(originCapture.auth).toBe(`Bearer ${SECRET}`)
    expect(finalCapture.auth).toBe(`Bearer ${SECRET}`) // same hostname → token survives
    expect(readFileSync(dest, "utf8")).toBe(body)
  })

  it("strips the token when the redirect changes host", async () => {
    const body = "cross-host-bytes"
    const finalCapture: { auth?: string } = {}
    // second loopback address = different hostname string, no DNS involved
    const final = await serve(
      serveBody(body, { sha: createHash("sha256").update(body).digest("hex"), capture: finalCapture }),
      "127.0.0.2",
    )
    const originCapture: { auth?: string } = {}
    const origin = await serve((req, res) => {
      originCapture.auth = req.headers.authorization
      res.writeHead(302, { location: `${final.origin}/file` })
      res.end()
    })

    await downloadFile(`${origin.origin}/resolve`, dest, SECRET, { allowedHosts: ALLOWED })

    expect(originCapture.auth).toBe(`Bearer ${SECRET}`) // origin always gets it
    expect(finalCapture.auth).toBeUndefined() // cross-host hop never sees it
    expect(readFileSync(dest, "utf8")).toBe(body)
  })

  it("refuses a redirect to a host outside the allowlist before connecting", async () => {
    const banned = await serve((req, res, server) => {
      server.hits.count += 1
      res.writeHead(200, { "content-length": "3" })
      res.end("bad")
    }, "127.0.0.2")
    const origin = await serve((req, res) => {
      res.writeHead(302, { location: `${banned.origin}/file` })
      res.end()
    })

    await expect(
      downloadFile(`${origin.origin}/resolve`, dest, SECRET, { allowedHosts: ["127.0.0.1"] }),
    ).rejects.toThrow(/not an allowlisted/)
    expect(banned.hits.count).toBe(0) // never contacted — no token leak possible
    expect(existsSync(dest)).toBe(false)
  })

  it("refuses a plain-http hop to a non-loopback host (validation precedes any request)", async () => {
    await expect(downloadFile("http://huggingface.co/model/resolve/main/x.gguf", dest)).rejects.toThrow(/non-HTTPS/)
    expect(existsSync(dest)).toBe(false)
  })

  it("stops after the redirect cap instead of following loops forever", async () => {
    const origin = await serve((req, res, server) => {
      server.hits.count += 1
      res.writeHead(302, { location: `${server.origin}/loop` })
      res.end()
    })

    await expect(downloadFile(`${origin.origin}/resolve`, dest, undefined, { allowedHosts: ALLOWED })).rejects.toThrow(
      /Too many redirects/,
    )
    expect(origin.hits.count).toBe(6) // initial hop + 5 follows, 6th redirect refused
    expect(existsSync(dest)).toBe(false)
  })

  it("rejects a redirect with no location instead of piping its body into the file", async () => {
    const origin = await serve((req, res) => {
      res.writeHead(302)
      res.end("<html>moved</html>")
    })

    await expect(downloadFile(`${origin.origin}/resolve`, dest, undefined, { allowedHosts: ALLOWED })).rejects.toThrow(
      /redirect without a location/,
    )
    expect(existsSync(dest)).toBe(false) // old code wrote the HTML body as the model
  })
})

describe("integrity verification", () => {
  const body = "gguf-payload-bytes"
  const realSha = createHash("sha256").update(body).digest("hex")

  it("accepts a download whose bytes match the LFS sha256", async () => {
    const origin = await serve(serveBody(body, { sha: realSha }))
    await downloadFile(`${origin.origin}/resolve`, dest, undefined, { allowedHosts: ALLOWED })
    expect(readFileSync(dest, "utf8")).toBe(body)
  })

  it("removes the file and fails when the sha256 does not match", async () => {
    const forged = createHash("sha256").update("different-bytes").digest("hex")
    const origin = await serve(serveBody(body, { sha: forged }))

    await expect(downloadFile(`${origin.origin}/resolve`, dest, undefined, { allowedHosts: ALLOWED })).rejects.toThrow(
      /Integrity check failed/,
    )
    expect(existsSync(dest)).toBe(false)
  })

  it("accepts responses with no integrity header (non-LFS files have nothing to verify)", async () => {
    const origin = await serve(serveBody(body))
    await downloadFile(`${origin.origin}/resolve`, dest, undefined, { allowedHosts: ALLOWED })
    expect(readFileSync(dest, "utf8")).toBe(body)
  })
})

describe("input validation", () => {
  it("accepts only Hugging Face hostnames and their subdomains", () => {
    expect(isAllowedDownloadHost("huggingface.co")).toBe(true)
    expect(isAllowedDownloadHost("cdn-lfs.huggingface.co")).toBe(true)
    expect(isAllowedDownloadHost("hf.co")).toBe(true)
    expect(isAllowedDownloadHost("evil.example")).toBe(false)
    expect(isAllowedDownloadHost("huggingface.co.evil.example")).toBe(false)
    expect(isAllowedDownloadHost("evilhuggingface.co")).toBe(false)
  })

  it("rejects repository ids that could reshape the URL", () => {
    expect(assertHfRepoId("org/model")).toBe("org/model")
    expect(assertHfRepoId("model")).toBe("model")
    expect(() => assertHfRepoId("../../etc")).toThrow(/Invalid Hugging Face repository id/)
    expect(() => assertHfRepoId("a/b/c")).toThrow(/Invalid/)
    expect(() => assertHfRepoId("org/mod el")).toThrow(/Invalid/)
    expect(() => assertHfRepoId("org/model?x=1")).toThrow(/Invalid/)
    expect(() => assertHfRepoId("")).toThrow(/Invalid/)
  })

  it("rejects file paths with traversal or unsafe characters", () => {
    expect(assertHfFileArg("model.Q4_K_M.gguf")).toBe("model.Q4_K_M.gguf")
    expect(assertHfFileArg("ggufs/model.gguf")).toBe("ggufs/model.gguf")
    expect(() => assertHfFileArg("../model.gguf")).toThrow(/Invalid file path/)
    expect(() => assertHfFileArg("a/../b.gguf")).toThrow(/Invalid/)
    expect(() => assertHfFileArg("model.gguf?x=1")).toThrow(/Invalid/)
    expect(() => assertHfFileArg("model#frag")).toThrow(/Invalid/)
    expect(() => assertHfFileArg("")).toThrow(/Invalid/)
  })
})
