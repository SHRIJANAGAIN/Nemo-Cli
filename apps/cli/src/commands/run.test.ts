/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `run` headless fallback: piped output cannot host the Ink REPL (spawning
 * it there exits 0 having printed nothing — the audit's `run` no-op), so
 * those runs go through headless exec instead. `exec` is mocked: no model,
 * no processes, no stdin reads (a real fd-0 read would block the worker).
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as http from "http"
import type { AddressInfo } from "net"
import { listModelNames, runCommand, shouldRunHeadless } from "./run.js"

const execCtl = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: string; opts: unknown }>,
  reset(): void {
    execCtl.calls.length = 0
  },
}))

vi.mock("./exec.js", () => ({
  execCommand: async (prompt: string, opts: unknown) => {
    execCtl.calls.push({ prompt, opts })
  },
}))

describe("shouldRunHeadless", () => {
  it("is headless unless both streams are TTYs", () => {
    expect(shouldRunHeadless(true, true)).toBe(false)
    expect(shouldRunHeadless(false, true)).toBe(true)
    expect(shouldRunHeadless(true, false)).toBe(true)
    expect(shouldRunHeadless(undefined, undefined)).toBe(true)
  })
})

describe("runCommand headless fallback", () => {
  beforeEach(() => {
    execCtl.reset()
  })

  it("delegates the prompt to headless exec instead of spawning Ink when piped", async () => {
    // Vitest workers are piped (no TTY), so this takes the fallback path.
    await runCommand({ config: {} as never, prompt: "Reply OK" })
    expect(execCtl.calls).toEqual([{ prompt: "Reply OK", opts: { sessionFile: undefined } }])
  })

  it("carries sessionFile through to headless exec", async () => {
    await runCommand({ config: {} as never, prompt: "hi", sessionFile: "s.json" })
    expect(execCtl.calls).toEqual([{ prompt: "hi", opts: { sessionFile: "s.json" } }])
  })

  it("honours an explicit useInk=false", async () => {
    await runCommand({ config: {} as never, prompt: "hi", useInk: false })
    expect(execCtl.calls).toHaveLength(1)
  })
})

describe("listModelNames ollama list", () => {
  it("uses the Ollama-native /api/tags endpoint instead of /v1/models", async () => {
    let seenUrl = ""
    const server = http.createServer((req, res) => {
      seenUrl = req.url ?? ""
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ models: [{ name: "llama3.1:latest" }, { name: "qwen2.5-coder" }] }))
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const names = await listModelNames(`http://127.0.0.1:${port}`, "", "ollama")
      expect(names).toContain("llama3.1:latest")
      expect(names).toContain("qwen2.5-coder")
      expect(seenUrl).toBe("/api/tags")
    } finally {
      server.close()
    }
  })
})
