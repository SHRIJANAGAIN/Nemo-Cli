/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import { afterAll, describe, expect, it } from "vitest"
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
})

afterAll(() => {
  delete process.env.TRAYAMBAK_WEB_TOKEN
})
