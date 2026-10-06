/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { agentRunTimeoutMs, isAllowedSessionFile, startServer } from "./index.js"

const base = (port: number): string => `http://127.0.0.1:${port}`

async function boot(
  opts: Parameters<typeof startServer>[0],
): Promise<{ port: number; token: string; close: () => Promise<void> }> {
  const server = startServer({ host: "127.0.0.1", port: 0, ...opts })
  await new Promise<void>((resolve) => server.on("listening", resolve))
  const port = (server.address() as AddressInfo).port
  const token = (server as { effectiveToken?: string }).effectiveToken ?? ""
  return {
    port,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe("agent HTTP server", () => {
  it("answers /health without auth and reports liveness only (no model name)", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const res = await fetch(`${base(port)}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string; model?: string }
      expect(body.status).toBe("ok")
      // Deployment metadata does not belong on an unauthenticated endpoint.
      expect(body.model).toBeUndefined()
    } finally {
      await close()
    }
  })

  it("mints a bearer token even on loopback binds and gates everything behind it", async () => {
    const { port, token, close } = await boot({})
    try {
      // A token always exists now, even with no --token on 127.0.0.1.
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      // ...so the agent endpoint, the session index, the model list and the
      // license-admin tooling all refuse unauthenticated callers.
      for (const path of ["/v1/models", "/api/sessions", "/admin/licenses", "/admin/usage"]) {
        const bare = await fetch(`${base(port)}${path}`)
        expect(bare.status, path).toBe(401)
      }
      const agent = await fetch(`${base(port)}/v1/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      })
      expect(agent.status).toBe(401)
      // And the generated token opens them.
      const ok = await fetch(`${base(port)}/v1/models`, { headers: bearer(token) })
      expect(ok.status).toBe(200)
    } finally {
      await close()
    }
  })

  it("rejects protected routes without the bearer token", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const res = await fetch(`${base(port)}/v1/models`)
      expect(res.status).toBe(401)
      const ok = await fetch(`${base(port)}/v1/models`, {
        headers: { Authorization: "Bearer secret" },
      })
      expect(ok.status).toBe(200)
    } finally {
      await close()
    }
  })

  it("serves openapi + models + 404 JSON to an authenticated caller", async () => {
    const { port, token, close } = await boot({})
    try {
      const spec = (await (await fetch(`${base(port)}/openapi.json`, { headers: bearer(token) })).json()) as {
        openapi: string
      }
      expect(spec.openapi).toBe("3.0.0")
      const models = (await (await fetch(`${base(port)}/v1/models`, { headers: bearer(token) })).json()) as {
        data: unknown[]
      }
      expect(Array.isArray(models.data)).toBe(true)
      const missing = await fetch(`${base(port)}/nope`, { headers: bearer(token) })
      expect(missing.status).toBe(404)
    } finally {
      await close()
    }
  })

  it("rejects a sessionFile outside the sessions directory (no arbitrary-path transcript write)", async () => {
    const { port, token, close } = await boot({})
    try {
      const outside = await fetch(`${base(port)}/v1/agent`, {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", sessionFile: "../../../../important.json" }),
      })
      expect(outside.status).toBe(400)
      const absolute = await fetch(`${base(port)}/v1/agent`, {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", sessionFile: "C:\\Windows\\Temp\\evil.json" }),
      })
      expect(absolute.status).toBe(400)
    } finally {
      await close()
    }
  })

  it("refuses a foreign browser origin before any route runs — including unauthenticated ones", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const foreign = await fetch(`${base(port)}/health`, { headers: { Origin: "https://phishing.example" } })
      expect(foreign.status).toBe(403)
      expect(foreign.headers.get("access-control-allow-origin")).toBeNull()

      // The load-bearing case: /license/mint-trial is unauthenticated AND
      // mutating, and a "simple" cross-origin POST (text/plain, no preflight)
      // still used to reach it. The origin gate has to stop it server-side —
      // omitting CORS headers alone would not.
      const trial = await fetch(`${base(port)}/license/mint-trial`, {
        method: "POST",
        headers: { Origin: "https://phishing.example", "Content-Type": "text/plain" },
        body: "{}",
      })
      expect(trial.status).toBe(403)
    } finally {
      await close()
    }
  })

  it("allows same-origin and loopback origins and echoes the origin back", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const sameOrigin = await fetch(`${base(port)}/health`, { headers: { Origin: `http://127.0.0.1:${port}` } })
      expect(sameOrigin.status).toBe(200)
      expect(sameOrigin.headers.get("access-control-allow-origin")).toBe(`http://127.0.0.1:${port}`)
      expect(sameOrigin.headers.get("vary")).toBe("Origin")

      // A local dev server on another port is same-machine: still allowed.
      const loopback = await fetch(`${base(port)}/health`, { headers: { Origin: "http://localhost:5173" } })
      expect(loopback.status).toBe(200)
      expect(loopback.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
    } finally {
      await close()
    }
  })

  it("answers preflight 204 for an allowed origin and 403 for a refused one", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const refused = await fetch(`${base(port)}/v1/agent`, {
        method: "OPTIONS",
        headers: { Origin: "https://phishing.example" },
      })
      expect(refused.status).toBe(403)
      const allowed = await fetch(`${base(port)}/v1/agent`, {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      })
      expect(allowed.status).toBe(204)
    } finally {
      await close()
    }
  })

  it("honors an explicit origin allowlist and only restores the wildcard on demand", async () => {
    const listed = await boot({ token: "secret", corsOrigins: "https://console.skt.dev" })
    try {
      const ok = await fetch(`${base(listed.port)}/health`, { headers: { Origin: "https://console.skt.dev" } })
      expect(ok.status).toBe(200)
      const nope = await fetch(`${base(listed.port)}/health`, { headers: { Origin: "https://evil.example" } })
      expect(nope.status).toBe(403)
    } finally {
      await listed.close()
    }

    const wildcard = await boot({ token: "secret", corsOrigins: "*" })
    try {
      const res = await fetch(`${base(wildcard.port)}/health`, { headers: { Origin: "https://anywhere.example" } })
      expect(res.status).toBe(200)
      expect(res.headers.get("access-control-allow-origin")).toBe("*")
    } finally {
      await wildcard.close()
    }
  })

  it("fails closed on non-loopback binds: generates a token and enforces it", async () => {
    const server = startServer({ host: "0.0.0.0", port: 0 })
    await new Promise<void>((resolve) => server.on("listening", resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const generated = (server as { effectiveToken?: string }).effectiveToken ?? ""
      expect(generated).toMatch(/^[0-9a-f]{64}$/)
      const bare = await fetch(`${base(port)}/v1/models`)
      expect(bare.status).toBe(401)
      const ok = await fetch(`${base(port)}/v1/models`, {
        headers: { Authorization: `Bearer ${generated}` },
      })
      expect(ok.status).toBe(200)
      const health = await fetch(`${base(port)}/health`)
      expect(health.status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it("clamps the agent run timeout (server-side socket ceiling)", () => {
    expect(agentRunTimeoutMs({} as NodeJS.ProcessEnv)).toBe(120_000)
    expect(agentRunTimeoutMs({ TRAYAMBAK_AGENT_TIMEOUT_MS: "30000" } as NodeJS.ProcessEnv)).toBe(30_000)
    // Absurd values clamp instead of disabling the ceiling.
    expect(agentRunTimeoutMs({ TRAYAMBAK_AGENT_TIMEOUT_MS: "0" } as NodeJS.ProcessEnv)).toBe(5_000)
    expect(agentRunTimeoutMs({ TRAYAMBAK_AGENT_TIMEOUT_MS: "99999999" } as NodeJS.ProcessEnv)).toBe(600_000)
    expect(agentRunTimeoutMs({ TRAYAMBAK_AGENT_TIMEOUT_MS: "garbage" } as NodeJS.ProcessEnv)).toBe(120_000)
  })

  it("only allows session files inside the sessions directory", () => {
    const root = join(tmpdir(), "sessions-root-probe")
    expect(isAllowedSessionFile(join(root, "abc", "session.json"), root)).toBe(true)
    expect(isAllowedSessionFile(join(root, "..", "important.json"), root)).toBe(false)
    expect(isAllowedSessionFile("C:\\Windows\\Temp\\evil.json", root)).toBe(false)
    expect(isAllowedSessionFile(root, root)).toBe(false)
  })

  it("rejects missing prompt and oversize bodies on /v1/agent", async () => {
    const { port, token, close } = await boot({})
    try {
      const bad = await fetch(`${base(port)}/v1/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(token) },
        body: JSON.stringify({}),
      })
      expect(bad.status).toBe(400)
      const big = await fetch(`${base(port)}/v1/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(token) },
        body: JSON.stringify({ prompt: "x".repeat(2_000_000) }),
      })
      expect(big.status).toBe(413)
    } finally {
      await close()
    }
  }, 15000)

  it("mints 16-letter licenses behind the bearer token", async () => {
    const { port, close } = await boot({ token: "secret" })
    const auth = { Authorization: "Bearer secret" }
    try {
      const page = await fetch(`${base(port)}/admin`, { headers: auth })
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toContain("text/html")
      const anon = await fetch(`${base(port)}/admin/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pentest", days: 30 }),
      })
      expect(anon.status).toBe(401)
      for (const bad of [
        { plan: "gold", days: 30 },
        { plan: "pentest", days: 0 },
        { plan: "pentest", days: 99999 },
        {},
      ]) {
        const r = await fetch(`${base(port)}/admin/mint`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify(bad),
        })
        expect(r.status).toBe(400)
      }
      const good = await fetch(`${base(port)}/admin/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        // days is a human duration from today (server converts to key epoch).
        body: JSON.stringify({ plan: "pro", days: 90 }),
      })
      expect(good.status).toBe(200)
      const { key } = (await good.json()) as { key: string }
      expect(key).toMatch(/^1102-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
      const { verifyLicenseKey } = await import("../../../apps/runtime/src/license.js")
      const v = verifyLicenseKey(key)
      expect(v.valid).toBe(true)
      if (v.valid) {
        expect(v.claims.plan).toBe("pro")
        expect(v.claims.exp * 1000).toBeGreaterThan(Date.now())
      }
    } finally {
      await close()
    }
  }, 15000)
})

afterAll(() => {
  delete process.env.TRAYAMBAK_WEB_TOKEN
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("server-side licensing", () => {
  async function bootLicensed(): Promise<{
    port: number
    auth: Record<string, string>
    close: () => Promise<void>
  }> {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "lic-srv-"))
    const { port, close } = await boot({
      token: "secret",
      licenseStorePath: join(dir, "licenses.json"),
      licenseUsagePath: join(dir, "usage.jsonl"),
      githubOAuthPath: join(dir, "oauth.json"),
    })
    return { port, auth: { Authorization: "Bearer secret" }, close }
  }

  async function mint(port: number, auth: Record<string, string>, plan = "pentest", days = 90): Promise<string> {
    const r = await fetch(`${base(port)}/admin/mint`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ plan, days }),
    })
    expect(r.status).toBe(200)
    const { key, id } = (await r.json()) as { key: string; id: string }
    expect(key).toMatch(/^1102-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(typeof id).toBe("string")
    return key
  }

  it("leaves /license/* public while /admin/* stays bearer-gated", async () => {
    const { port, close } = await bootLicensed()
    try {
      const pub = await fetch(`${base(port)}/license/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "1102-AAAA-BBBB-CCCC", machineId: "machine-1" }),
      })
      expect(pub.status).toBe(200)
      const gated = await fetch(`${base(port)}/admin/licenses`)
      expect(gated.status).toBe(401)
      const installer = await fetch(`${base(port)}/install.ps1`)
      expect(installer.status).toBe(200)
      expect(await installer.text()).toContain("npm install -g @skt-ai-labs/trayambak-cli")
      // macOS/Linux one-liner serves the animated bash installer too.
      const sh = await fetch(`${base(port)}/install.sh`)
      expect(sh.status).toBe(200)
      expect(await sh.text()).toContain("npm install -g @skt-ai-labs/trayambak-cli")
      // Docs pages serve as markdown; traversal and odd names 404.
      const docDir = mkdtempSync(join(tmpdir(), "lic-doc-"))
      writeFileSync(join(docDir, "getting-started.md"), "# Getting started\n")
      const { port: portDocs, close: closeDocs } = await boot({
        token: "secret",
        licenseStorePath: join(mkdtempSync(join(tmpdir(), "lic-doc1-")), "l.json"),
        licenseUsagePath: join(mkdtempSync(join(tmpdir(), "lic-doc2-")), "u.jsonl"),
        githubOAuthPath: join(mkdtempSync(join(tmpdir(), "lic-doc3-")), "o.json"),
        imgDir: docDir,
        docsDir: docDir,
      })
      try {
        const doc = await fetch(`${base(portDocs)}/docs/getting-started.md`)
        expect(doc.status).toBe(200)
        expect(doc.headers.get("content-type")).toContain("text/markdown")
        expect(await doc.text()).toContain("Getting started")
        // Encoded slashes stay encoded on the wire — the whitelist sees
        // only literal characters, so traversal can never address a file.
        expect((await fetch(`${base(portDocs)}/docs/a%2Fb.md`)).status).toBe(404)
        expect((await fetch(`${base(portDocs)}/docs/evil.txt`)).status).toBe(404)
      } finally {
        await closeDocs()
      }
      // README images: real png serves, traversal and odd names 404.
      const imgDir = mkdtempSync(join(tmpdir(), "lic-img-"))
      writeFileSync(join(imgDir, "IM1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const { port: port2, close: close2 } = await boot({
        token: "secret",
        licenseStorePath: join(mkdtempSync(join(tmpdir(), "lic-img2-")), "l.json"),
        licenseUsagePath: join(mkdtempSync(join(tmpdir(), "lic-img3-")), "u.jsonl"),
        githubOAuthPath: join(mkdtempSync(join(tmpdir(), "lic-img4-")), "o.json"),
        imgDir,
      })
      try {
        const png = await fetch(`${base(port2)}/img/IM1.png`)
        expect(png.status).toBe(200)
        expect(png.headers.get("content-type")).toBe("image/png")
        expect((await png.arrayBuffer()).byteLength).toBe(4)
        // The whitelist has no slashes/dots-outside-extension by
        // construction: traversal names can never address a file.
        expect((await fetch(`${base(port2)}/img/a%20b.png`)).status).toBe(404)
        expect((await fetch(`${base(port2)}/img/evil.exe`)).status).toBe(404)
        expect((await fetch(`${base(port2)}/img/missing.png`)).status).toBe(404)
      } finally {
        await close2()
      }
    } finally {
      await close()
    }
  })

  it("runs mint -> activate -> verify -> usage -> revoke end to end", async () => {
    const { port, auth, close } = await bootLicensed()
    try {
      const key = await mint(port, auth)
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base(port)}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        })
      // Known but unactivated: verify refuses with the bind hint.
      const pre = (await (await post("/license/verify", { key, machineId: "machine-1" })).json()) as {
        valid: boolean
        reason?: string
      }
      expect(pre.valid).toBe(false)
      expect(pre.reason ?? "").toContain("not activated")
      // Activate binds machine 1 (idempotent on repeat).
      const act = (await (await post("/license/activate", { key, machineId: "machine-1" })).json()) as {
        ok: boolean
        plan?: string
      }
      expect(act.ok).toBe(true)
      expect(act.plan).toBe("pentest")
      expect(
        ((await (await post("/license/activate", { key, machineId: "machine-1" })).json()) as { ok: boolean }).ok,
      ).toBe(true)
      // Bound machine verifies; a second machine does not.
      const ok = (await (await post("/license/verify", { key, machineId: "machine-1" })).json()) as {
        valid: boolean
        plan?: string
      }
      expect(ok).toMatchObject({ valid: true, plan: "pentest" })
      const other = (await (await post("/license/verify", { key, machineId: "machine-2" })).json()) as {
        valid: boolean
        reason?: string
      }
      expect(other.valid).toBe(false)
      expect(other.reason ?? "").toContain("another machine")
      const clash = (await (await post("/license/activate", { key, machineId: "machine-2" })).json()) as { ok: boolean }
      expect(clash.ok).toBe(false)
      // Usage audit: bound machine records, stranger gets 403.
      const use = await post("/license/usage", {
        key,
        machineId: "machine-1",
        tool: "trayambak__PentestRunTool",
        target: "example.com",
      })
      expect(use.status).toBe(200)
      const useNo = await post("/license/usage", { key, machineId: "machine-2", tool: "trayambak__PentestRunTool" })
      expect(useNo.status).toBe(403)
      // Admin sees the masked license + the usage line.
      const list = (await (await fetch(`${base(port)}/admin/licenses`, { headers: auth })).json()) as {
        licenses: Array<{ bound: boolean; plan: string }>
      }
      expect(list.licenses).toHaveLength(1)
      expect(list.licenses[0]).toMatchObject({ bound: true, plan: "pentest" })
      const usage = (await (await fetch(`${base(port)}/admin/usage?tail=10`, { headers: auth })).json()) as {
        usage: Array<{ tool: string; target: string }>
      }
      expect(usage.usage).toHaveLength(1)
      expect(usage.usage[0]).toMatchObject({ tool: "trayambak__PentestRunTool", target: "example.com" })
      // Unbind migrates the key; revoke kills it.
      expect(((await (await post("/admin/unbind", { id: key }, auth)).json()) as { ok: boolean }).ok).toBe(true)
      expect(
        ((await (await post("/license/activate", { key, machineId: "machine-2" })).json()) as { ok: boolean }).ok,
      ).toBe(true)
      expect(((await (await post("/admin/revoke", { id: key }, auth)).json()) as { ok: boolean }).ok).toBe(true)
      const dead = (await (await post("/license/verify", { key, machineId: "machine-2" })).json()) as {
        valid: boolean
        reason?: string
      }
      expect(dead.valid).toBe(false)
      expect(dead.reason ?? "").toContain("revoked")
    } finally {
      await close()
    }
  }, 30000)

  it("rejects forged codes (valid checksum, never registered)", async () => {
    const { port, close } = await bootLicensed()
    try {
      const { mintActivationKey, activationCheckKey, activationEpochDays } =
        await import("../../../apps/runtime/src/license.js")
      const today = Math.floor(Date.now() / 86400000)
      const forged = mintActivationKey(
        { plan: "pentest", expDays: today - activationEpochDays() + 90 },
        activationCheckKey(),
      )
      const r = await fetch(`${base(port)}/license/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: forged, machineId: "machine-1" }),
      })
      expect(r.status).toBe(200)
      const j = (await r.json()) as { valid: boolean; reason?: string }
      // Checksum verifies — the registry doesn't know it. This is the whole
      // point of server-side licensing: extracted secrets mint nothing.
      expect(j.valid).toBe(false)
      expect(j.reason ?? "").toContain("not issued")
    } finally {
      await close()
    }
  }, 15000)

  it("imports legacy codes so old holders can re-activate", async () => {
    const { port, auth, close } = await bootLicensed()
    try {
      // Legacy (ver=1) code minted fresh — no hardcoded expiry to rot on.
      const { mintLegacyActivationKey, activationCheckKey, activationEpochDays } =
        await import("../../../apps/runtime/src/license.js")
      const today = Math.floor(Date.now() / 86400000)
      const legacy = mintLegacyActivationKey(
        { plan: "pentest", expDays: today - activationEpochDays() + 365 },
        activationCheckKey(),
      )
      const imp = await fetch(`${base(port)}/admin/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ key: legacy, customer: "legacy-test" }),
      })
      expect(imp.status).toBe(200)
      const bad = await fetch(`${base(port)}/admin/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ key: "1102-AAAA-BBBB-CCCC" }),
      })
      expect(bad.status).toBe(400)
      const act = await fetch(`${base(port)}/license/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: legacy, machineId: "field-machine" }),
      })
      expect(((await act.json()) as { ok: boolean }).ok).toBe(true)
      const v = await fetch(`${base(port)}/license/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: legacy, machineId: "field-machine" }),
      })
      expect(((await v.json()) as { valid: boolean }).valid).toBe(true)
    } finally {
      await close()
    }
  }, 15000)

  it("self-serves one born-bound trial per machine, then revokes it", async () => {
    const { port, auth, close } = await bootLicensed()
    try {
      const trial = (machineId: string) =>
        fetch(`${base(port)}/license/mint-trial`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ machineId }),
        })
      // Public: no bearer needed.
      const first = await trial("trial-machine-1")
      expect(first.status).toBe(200)
      const t = (await first.json()) as { ok: boolean; key: string; id: string; days: number }
      expect(t.ok).toBe(true)
      expect(t.key).toMatch(/^1102-/)
      expect(t.days).toBe(7)
      // Born bound: verifies immediately on its machine, nowhere else.
      const verify = (key: string, machineId: string) =>
        fetch(`${base(port)}/license/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, machineId }),
        })
      expect(((await (await verify(t.key, "trial-machine-1")).json()) as { valid: boolean; plan: string }).plan).toBe(
        "pentest",
      )
      expect(((await (await verify(t.key, "trial-machine-2")).json()) as { valid: boolean }).valid).toBe(false)
      // One live trial per machine.
      const again = await trial("trial-machine-1")
      expect(again.status).toBe(409)
      // …but a fresh machine gets its own.
      expect((await trial("trial-machine-2")).status).toBe(200)
      // Usage audit works on the trial, and the admin list flags it.
      const use = await fetch(`${base(port)}/license/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: t.key,
          machineId: "trial-machine-1",
          tool: "trayambak__PentestRunTool",
          target: "evil.example",
        }),
      })
      expect(use.status).toBe(200)
      const list = (await (await fetch(`${base(port)}/admin/licenses`, { headers: auth })).json()) as {
        licenses: Array<{ id: string; trial: boolean; bound: boolean }>
      }
      expect(list.licenses.find((l) => l.id === t.id)).toMatchObject({ trial: true, bound: true })
      // Exploitation? One click and it is dead everywhere.
      const rev = await fetch(`${base(port)}/admin/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ id: t.id }),
      })
      expect(((await rev.json()) as { ok: boolean }).ok).toBe(true)
      expect(((await (await verify(t.key, "trial-machine-1")).json()) as { valid: boolean }).valid).toBe(false)
    } finally {
      await close()
    }
  }, 30000)

  it("rate-limits trial mints per network", async () => {
    const { port, close } = await bootLicensed()
    try {
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) {
        const r = await fetch(`${base(port)}/license/mint-trial`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ machineId: `flood-machine-${i}` }),
        })
        statuses.push(r.status)
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
      expect(statuses[5]).toBe(429)
    } finally {
      await close()
    }
  }, 30000)
})

describe("github webhook auth", () => {
  it("leaves /webhooks/github on HMAC auth even when a bearer token is set", async () => {
    // Regression: gating webhooks behind bearer 401s every GitHub delivery
    // ("unauthorized") before the signature is checked — GitHub holds no
    // bearer token, HMAC IS its auth.
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "hook-secret-for-tests")
    const { port, close } = await boot({ token: "secret" })
    try {
      const hook = (body: string, sig: string | undefined, event: string) =>
        fetch(`${base(port)}/webhooks/github`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(sig ? { "X-Hub-Signature-256": sig } : {}),
            "X-GitHub-Event": event,
          },
          body,
        })
      // No bearer anywhere: a bad signature must fail at the HMAC gate
      // ("bad signature"), never at the bearer gate ("unauthorized").
      const bad = await hook(JSON.stringify({ zen: "x" }), "sha256=deadbeef", "ping")
      expect(bad.status).toBe(401)
      expect(((await bad.json()) as { error: string }).error).toBe("bad signature")
      // A correctly-signed ping answers 200 with no bearer involved.
      const body = JSON.stringify({ zen: "hello" })
      const sig = `sha256=${createHmac("sha256", "hook-secret-for-tests").update(body).digest("hex")}`
      const pong = await hook(body, sig, "ping")
      expect(pong.status).toBe(200)
      expect(((await pong.json()) as { ok: boolean }).ok).toBe(true)
    } finally {
      await close()
    }
  }, 15000)
})

describe("VPS-routed GitHub writes", () => {
  const REAL_FETCH = globalThis.fetch

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Boot with one logged-in machine; api.github.com answers canned while
   *  every other URL (the server under test) rides the real fetch. */
  async function bootLoggedIn(
    gh: (url: string, method: string) => { status: number; json: unknown },
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const dir = mkdtempSync(join(tmpdir(), "gh-vps-"))
    writeFileSync(
      join(dir, "oauth.json"),
      JSON.stringify({
        version: 1,
        states: {},
        tokens: {
          "machine-1": { machineId: "machine-1", token: "gho-test", login: "octocat", createdAt: Date.now() },
        },
      }),
    )
    vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      if (!u.startsWith("https://api.github.com")) return REAL_FETCH(u, init)
      const { status, json } = gh(u, (init?.method ?? "GET").toUpperCase())
      return { status, json: async () => json } as unknown as Response
    })
    return boot({
      token: "secret",
      licenseStorePath: join(dir, "l.json"),
      licenseUsagePath: join(dir, "u.jsonl"),
      githubOAuthPath: join(dir, "oauth.json"),
    })
  }

  // /github/* is bearer-gated (like every non-public route), so the helper
  // presents the test token — the OAuth gate underneath is what these tests
  // exercise.
  const post = (port: number, path: string, body: unknown) =>
    fetch(`${base(port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify(body),
    })

  it("401s logged-out machines on every VPS GitHub route", async () => {
    const { port, close } = await boot({
      token: "secret",
      licenseStorePath: join(mkdtempSync(join(tmpdir(), "gh-vps-out-")), "l.json"),
      licenseUsagePath: join(mkdtempSync(join(tmpdir(), "gh-vps-out2-")), "u.jsonl"),
      githubOAuthPath: join(mkdtempSync(join(tmpdir(), "gh-vps-out3-")), "o.json"),
    })
    try {
      // No bearer at all: the token gate answers first.
      expect((await fetch(`${base(port)}/github/repos?machineId=machine-1`)).status).toBe(401)
      // Bearer but no OAuth login: the login gate answers.
      expect(
        (
          await fetch(`${base(port)}/github/repos?machineId=machine-1`, {
            headers: { Authorization: "Bearer secret" },
          })
        ).status,
      ).toBe(401)
      const bodies: Array<[string, unknown]> = [
        ["/github/write", { machineId: "machine-1", repo: "o/r", path: "a.md", content: "x" }],
        ["/github/branch", { machineId: "machine-1", repo: "o/r", branch: "x" }],
        ["/github/pr", { machineId: "machine-1", repo: "o/r", head: "x", title: "t" }],
        ["/github/copy", { machineId: "machine-1", repo: "o/r", sourcePath: "a", destPath: "b" }],
      ]
      for (const [path, body] of bodies) {
        const r = await post(port, path, body)
        expect(r.status).toBe(401)
        expect(((await r.json()) as { error: string }).error).toContain("/github login")
      }
    } finally {
      await close()
    }
  })

  it("lists repos, writes, branches, PRs, and copies as the logged-in user", async () => {
    const { port, close } = await bootLoggedIn((u, method) => {
      if (u.includes("/user/repos"))
        return {
          status: 200,
          json: [
            {
              full_name: "octocat/mytest1",
              private: false,
              default_branch: "main",
              updated_at: "2026-09-30T00:00:00Z",
            },
          ],
        }
      if (u.includes("/contents/README.md"))
        return method === "PUT"
          ? { status: 201, json: { commit: { sha: "aaa1111" } } }
          : { status: 404, json: { message: "Not Found" } }
      if (u.includes("/contents/src/a.txt"))
        return {
          status: 200,
          json: { content: Buffer.from("hello").toString("base64") },
        }
      if (u.includes("/contents/src/b.txt"))
        return method === "PUT"
          ? { status: 201, json: { commit: { sha: "bbb2222" } } }
          : { status: 404, json: { message: "Not Found" } }
      if (u.includes("/git/ref/heads/main")) return { status: 200, json: { object: { sha: "abc123" } } }
      if (u.includes("/git/refs")) return { status: 201, json: { ref: "refs/heads/trayambak/x" } }
      if (u.includes("/pulls")) return { status: 201, json: { number: 7, html_url: "https://github.com/o/r/pull/7" } }
      if (u.endsWith("/repos/o/r")) return { status: 200, json: { default_branch: "main" } }
      return { status: 404, json: { message: "Not Found" } }
    })
    try {
      const repos = await fetch(`${base(port)}/github/repos?machineId=machine-1`, {
        headers: { Authorization: "Bearer secret" },
      })
      expect(repos.status).toBe(200)
      const list = (await repos.json()) as { ok: boolean; login: string; repos: Array<{ fullName: string }> }
      expect(list.ok).toBe(true)
      expect(list.login).toBe("octocat")
      expect(list.repos.map((r) => r.fullName)).toEqual(["octocat/mytest1"])

      const write = await post(port, "/github/write", {
        machineId: "machine-1",
        repo: "o/r",
        path: "README.md",
        content: "# mytest1",
      })
      expect(write.status).toBe(200)
      expect(((await write.json()) as { ok: boolean; commit: string }).commit).toBe("aaa1111")

      // Traversal never reaches GitHub: the route refuses first.
      const evil = await post(port, "/github/write", {
        machineId: "machine-1",
        repo: "o/r",
        path: "../evil.md",
        content: "x",
      })
      expect(evil.status).toBe(400)

      const br = await post(port, "/github/branch", { machineId: "machine-1", repo: "o/r", branch: "trayambak/x" })
      expect(br.status).toBe(200)
      expect(((await br.json()) as { ok: boolean; base: string }).base).toBe("main")

      const pr = await post(port, "/github/pr", {
        machineId: "machine-1",
        repo: "o/r",
        head: "trayambak/x",
        title: "Fix",
      })
      expect(pr.status).toBe(200)
      expect(((await pr.json()) as { ok: boolean; number: number }).number).toBe(7)

      const cp = await post(port, "/github/copy", {
        machineId: "machine-1",
        repo: "o/r",
        sourcePath: "src/a.txt",
        destPath: "src/b.txt",
      })
      expect(cp.status).toBe(200)
      expect(((await cp.json()) as { ok: boolean; commit: string }).commit).toBe("bbb2222")
    } finally {
      await close()
    }
  })
})

describe("server hardening headers and limits", () => {
  it("sends clickjacking/sniffing/referrer/sensor guards on every response", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      for (const path of ["/health", "/openapi.json", "/nope"]) {
        const res = await fetch(`${base(port)}${path}`, { headers: bearer("secret") })
        expect(res.headers.get("x-frame-options")).toBe("DENY")
        expect(res.headers.get("x-content-type-options")).toBe("nosniff")
        expect(res.headers.get("referrer-policy")).toBe("no-referrer")
        expect(res.headers.get("permissions-policy")).toContain("camera=()")
        expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      }
      // Error paths carry them too (unauthorized + unknown route above).
      const denied = await fetch(`${base(port)}/v1/models`)
      expect(denied.status).toBe(401)
      expect(denied.headers.get("x-frame-options")).toBe("DENY")
    } finally {
      await close()
    }
  })

  it("rejects oversized URLs (414) and header blocks (431)", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const huge = await fetch(`${base(port)}/${"a".repeat(3000)}`, { headers: bearer("secret") })
      expect(huge.status).toBe(414)
      const fat = await fetch(`${base(port)}/health`, {
        headers: { ...bearer("secret"), "x-pad": "x".repeat(9000) },
      })
      expect(fat.status).toBe(431)
      // Just under the caps still works.
      const ok = await fetch(`${base(port)}/health`, { headers: bearer("secret") })
      expect(ok.status).toBe(200)
    } finally {
      await close()
    }
  })

  it("serves /.well-known/security.txt publicly with the support contact", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const res = await fetch(`${base(port)}/.well-known/security.txt`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/plain")
      const body = await res.text()
      expect(body).toContain("Contact: mailto:support@sktailabs.in")
      expect(body).toContain("Expires:")
    } finally {
      await close()
    }
  })
})
