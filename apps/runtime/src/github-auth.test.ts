/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  copyGithubFileViaServer,
  createGithubBranchViaServer,
  createGithubPrViaServer,
  githubLoginStatus,
  githubLogout,
  listGithubRepos,
  openBrowser,
  pollGithubLogin,
  readGithubIssue,
  startGithubLogin,
  writeGithubFileViaServer,
} from "./github-auth.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

function tmpMachine(): void {
  vi.stubEnv("NEMO_MACHINE_ID_FILE", join(mkdtempSync(join(tmpdir(), "gh-auth-")), "machine-id"))
}

/** In-test auth server: canned OAuth + read endpoints on loopback. */
async function stubAuthServer(routes: Record<string, (body: string) => { status: number; json: unknown }>) {
  const seen: string[] = []
  const server = createServer((req, res) => {
    let data = ""
    req.on("data", (c) => {
      data += c.toString()
    })
    req.on("end", () => {
      const url = (req.url ?? "").split("?")[0]
      const key = `${req.method} ${url}`
      const route = Object.entries(routes).find(([routeKey]) => routeKey === key)?.[1]
      seen.push(`${req.method} ${req.url}`)
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "not found" }))
        return
      }
      const { status, json } = route(data)
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}

describe("github-auth client", () => {
  it("runs start -> status -> read -> logout against a live stub", async () => {
    tmpMachine()
    const s = await stubAuthServer({
      "POST /auth/github/start": () => ({
        status: 200,
        json: { ok: true, url: "https://github.com/login/oauth/authorize?x=1" },
      }),
      "GET /auth/github/status": () => ({ status: 200, json: { authorized: true, login: "octocat" } }),
      "POST /github/read": () => ({
        status: 200,
        json: { ok: true, issue: { number: 1, title: "Hi" }, comments: [] },
      }),
      "POST /auth/github/logout": () => ({ status: 200, json: { ok: true } }),
    })
    try {
      const start = await startGithubLogin({ serverUrl: s.url })
      expect(start).toMatchObject({ ok: true })
      expect(start.url).toContain("github.com/login/oauth/authorize")
      const poll = await pollGithubLogin({ serverUrl: s.url, tries: 2, intervalMs: 500 })
      expect(poll).toMatchObject({ authorized: true, login: "octocat" })
      const read = await readGithubIssue("o/r", 1, { serverUrl: s.url })
      expect(read.ok).toBe(true)
      expect(read.issue).toMatchObject({ number: 1 })
      expect((await githubLogout({ serverUrl: s.url })).ok).toBe(true)
      expect(s.seen.some((u) => u.startsWith("POST /auth/github/start"))).toBe(true)
    } finally {
      await s.close()
    }
  })

  it("surfaces refusals and unreachable servers as values", async () => {
    tmpMachine()
    const s = await stubAuthServer({
      "POST /auth/github/start": () => ({ status: 429, json: { ok: false, reason: "too many" } }),
      "GET /auth/github/status": () => ({ status: 200, json: { authorized: false } }),
      "POST /github/read": () => ({ status: 401, json: { error: "login required" } }),
    })
    try {
      expect((await startGithubLogin({ serverUrl: s.url })).reason).toContain("too many")
      const poll = await pollGithubLogin({ serverUrl: s.url, tries: 1, intervalMs: 500 })
      expect(poll.authorized).toBe(false)
      const read = await readGithubIssue("o/r", 1, { serverUrl: s.url })
      expect(read.ok).toBe(false)
      expect(read.reason).toContain("/github login")
      const dead = await githubLoginStatus({ serverUrl: "http://127.0.0.1:1", timeoutMs: 1000 })
      expect(dead.authorized).toBe(false)
    } finally {
      await s.close()
    }
  })

  it("openBrowser respects the headless opt-out", () => {
    vi.stubEnv("NEMO_NO_BROWSER", "1")
    expect(openBrowser("https://example.com")).toBe(false)
  })

  it("rides the VPS for repos, writes, branches, PRs, and copies", async () => {
    tmpMachine()
    const s = await stubAuthServer({
      "GET /github/repos": () => ({
        status: 200,
        json: { ok: true, login: "octocat", repos: [{ fullName: "octocat/mytest1" }] },
      }),
      "POST /github/write": () => ({ status: 200, json: { ok: true, commit: "aaa1111" } }),
      "POST /github/branch": () => ({ status: 200, json: { ok: true, base: "main" } }),
      "POST /github/pr": () => ({ status: 200, json: { ok: true, number: 7, url: "https://github.com/o/r/pull/7" } }),
      "POST /github/copy": () => ({ status: 200, json: { ok: true, commit: "bbb2222" } }),
    })
    try {
      const repos = await listGithubRepos({ serverUrl: s.url })
      expect(repos.ok).toBe(true)
      expect(repos.login).toBe("octocat")
      expect(repos.repos?.map((r) => r.fullName)).toEqual(["octocat/mytest1"])
      const w = await writeGithubFileViaServer("o/r", "README.md", "# hi", "docs", undefined, { serverUrl: s.url })
      expect(w).toMatchObject({ ok: true, commit: "aaa1111" })
      const b = await createGithubBranchViaServer("o/r", "nemo/x", undefined, { serverUrl: s.url })
      expect(b).toMatchObject({ ok: true, base: "main" })
      const p = await createGithubPrViaServer("o/r", "nemo/x", undefined, "Fix", "", { serverUrl: s.url })
      expect(p).toMatchObject({ ok: true, number: 7 })
      const c = await copyGithubFileViaServer("o/r", "a", "b", { serverUrl: s.url })
      expect(c).toMatchObject({ ok: true, commit: "bbb2222" })
      expect(s.seen.filter((u) => u.startsWith("POST /github/") || u.startsWith("GET /github/"))).toHaveLength(5)
    } finally {
      await s.close()
    }
  })

  it("maps VPS 401s to the login hint on every write route", async () => {
    tmpMachine()
    const s = await stubAuthServer({
      "GET /github/repos": () => ({ status: 401, json: { error: "GitHub login required" } }),
      "POST /github/write": () => ({ status: 401, json: { error: "GitHub login required" } }),
      "POST /github/branch": () => ({ status: 401, json: { error: "GitHub login required" } }),
      "POST /github/pr": () => ({ status: 401, json: { error: "GitHub login required" } }),
      "POST /github/copy": () => ({ status: 401, json: { error: "GitHub login required" } }),
    })
    try {
      for (const r of [
        await listGithubRepos({ serverUrl: s.url }),
        await writeGithubFileViaServer("o/r", "a.md", "x", "m", undefined, { serverUrl: s.url }),
        await createGithubBranchViaServer("o/r", "x", undefined, { serverUrl: s.url }),
        await createGithubPrViaServer("o/r", "x", undefined, "t", "", { serverUrl: s.url }),
        await copyGithubFileViaServer("o/r", "a", "b", { serverUrl: s.url }),
      ]) {
        expect(r.ok).toBe(false)
        expect(r.reason).toContain("/github login")
      }
    } finally {
      await s.close()
    }
  })
})
