/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { createHmac } from "node:crypto"
import type { AddressInfo } from "node:net"
import { startServer } from "./index.js"

const base = (port: number): string => `http://127.0.0.1:${port}`

async function boot(opts: Parameters<typeof startServer>[0]): Promise<{ port: number; close: () => Promise<void> }> {
  const server = startServer({ host: "127.0.0.1", port: 0, ...opts })
  await new Promise<void>((resolve) => server.on("listening", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

describe("agent HTTP server", () => {
  it("answers /health without auth and reports the model", async () => {
    const { port, close } = await boot({ token: "secret" })
    try {
      const res = await fetch(`${base(port)}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string; model: string }
      expect(body.status).toBe("ok")
      expect(typeof body.model).toBe("string")
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

  it("serves openapi + models + 404 JSON", async () => {
    const { port, close } = await boot({})
    try {
      const spec = (await (await fetch(`${base(port)}/openapi.json`)).json()) as { openapi: string }
      expect(spec.openapi).toBe("3.0.0")
      const models = (await (await fetch(`${base(port)}/v1/models`)).json()) as { data: unknown[] }
      expect(Array.isArray(models.data)).toBe(true)
      const missing = await fetch(`${base(port)}/nope`)
      expect(missing.status).toBe(404)
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

  it("keeps loopback no-token behaviour (documented local-dev mode)", async () => {
    const { port, close } = await boot({})
    try {
      const res = await fetch(`${base(port)}/v1/models`)
      expect(res.status).toBe(200)
    } finally {
      await close()
    }
  })

  it("rejects missing prompt and oversize bodies on /v1/agent", async () => {
    const { port, close } = await boot({})
    try {
      const bad = await fetch(`${base(port)}/v1/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(bad.status).toBe(400)
      const big = await fetch(`${base(port)}/v1/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
