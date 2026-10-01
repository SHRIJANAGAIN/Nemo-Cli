/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * github tool — no sockets, ever.
 *
 * node:https/http are replaced with a URL-routed stand-in keyed by path
 * substring (string shorthand = 200, {status, body} objects, arrays consumed
 * in order so the copy flow can see GET 404 then PUT 201 on the same path,
 * `null` = transport error; unmatched paths get GitHub's 404 Not Found).
 *
 * Pins the bug fixes:
 *  - get_tree resolves `default_branch` (hardcoded `main` 404'd master repos)
 *  - contents paths are encoded per segment (whole-path encoding sent
 *    `src%2Fx.ts` and 404'd every nested file)
 *  - HTTP status + API `message` surface instead of "empty tree"/"no content"
 *  - copy_files performs the real GET/GET/PUT flow (it used to return a
 *    success-looking stub) and honestly refuses without a write token
 *  - parseRepo accepts scheme-less `github.com/owner/repo`
 *  - tokenless writes ride the VPS login (global fetch stub below, default
 *    logged-out 401): api.github.com is never touched on that path
 */

import { EventEmitter } from "node:events"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../types.js"
import type { ToolContext } from "../types.js"
import { createGithubTool, parseRepo } from "./github.js"

type MockResponse = string | null | { status: number; body: string }

/** Route table shared with the http(s) mocks (vi.hoisted → exists before the
 *  hoisted vi.mock factories and the imported tool module run). */
const net = vi.hoisted(() => {
  const routes = new Map<string, MockResponse | MockResponse[]>()
  const requests: string[] = []
  const writes: string[] = []
  const methods: string[] = []
  const headers: Array<Record<string, string>> = []
  return {
    routes,
    requests,
    writes,
    methods,
    headers,
    /** How many of the http(s) mock factories ran — never reset: if this
     *  stays 0 the suite would silently talk to the real network. */
    factoryHits: 0,
    reset(): void {
      routes.clear()
      requests.length = 0
      writes.length = 0
      methods.length = 0
      headers.length = 0
    },
    /** First matching route wins (insert more specific needles first: the
     *  trees/contents URLs also contain the shorter "/repos/o/r" prefix).
     *  Arrays consume in order and repeat the last entry. Unmatched paths get
     *  GitHub's 404 shape so missing routes fail loudly. */
    lookup(url: string): MockResponse {
      for (const [needle, value] of routes) {
        if (!url.includes(needle)) continue
        if (Array.isArray(value)) {
          if (value.length > 1) return value.shift() ?? null
          return value[0] ?? null
        }
        return value
      }
      return { status: 404, body: JSON.stringify({ message: "Not Found" }) }
    },
  }
})

/** VPS stand-in for tokenless writes (global fetch): api.github.com is
 *  mocked above via node:https/http, but the login-routed path uses fetch
 *  against the license server — without this stub those tests would hit
 *  the real network. String shorthand not needed: exact specs only,
 *  default is logged-out 401. */
const vps = vi.hoisted(() => {
  const routes = new Map<string, { status: number; json: unknown }>()
  const calls: string[] = []
  return {
    routes,
    calls,
    reset(): void {
      routes.clear()
      calls.length = 0
    },
  }
})

interface MockReq extends EventEmitter {
  setTimeout(_ms: number, _cb?: () => void): MockReq
  write(_chunk: string): void
  end(): void
  destroy(): void
}

interface MockRes extends EventEmitter {
  statusCode?: number
}

/** node:https/http stand-in: no sockets, canned responses keyed by URL. */
function buildHttpModule(): { get: unknown; request: unknown } {
  const deliver = (url: string, onResp: (res: MockRes) => void, req: EventEmitter): void => {
    net.requests.push(url)
    setImmediate(() => {
      const spec = net.lookup(url)
      if (spec === null) {
        req.emit("error", new Error("ECONNREFUSED (mock transport)"))
        return
      }
      const res = new EventEmitter() as MockRes
      const cfg = typeof spec === "string" ? { status: 200, body: spec } : spec
      res.statusCode = cfg.status
      // Callback first: it reads statusCode synchronously and attaches its
      // data/end listeners before the body is emitted.
      onResp(res)
      if (cfg.body.length > 0) res.emit("data", Buffer.from(cfg.body, "utf8"))
      res.emit("end")
    })
  }
  const makeReq = (url: string, onResp: (res: MockRes) => void, autoStart: boolean): MockReq => {
    const req = new EventEmitter() as MockReq
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      deliver(url, onResp, req)
    }
    req.setTimeout = (): MockReq => req
    req.write = (chunk: string): void => {
      net.writes.push(chunk)
    }
    req.destroy = (): void => {
      /* teardown is a no-op: the scheduled deliver still runs */
    }
    req.end = start
    if (autoStart) start()
    return req
  }
  return {
    get: (rawUrl: unknown, opts: { headers?: Record<string, string> }, onResp: (res: MockRes) => void): MockReq => {
      net.methods.push("GET")
      net.headers.push(opts.headers ?? {})
      return makeReq(String(rawUrl), onResp, /*autoStart*/ true)
    },
    request: (
      rawUrl: unknown,
      opts: { method?: string; headers?: Record<string, string> },
      onResp: (res: MockRes) => void,
    ): MockReq => {
      net.methods.push(opts.method ?? "POST")
      net.headers.push(opts.headers ?? {})
      return makeReq(String(rawUrl), onResp, /*autoStart*/ false)
    },
  }
}

vi.mock("https", () => {
  net.factoryHits++
  const api = buildHttpModule()
  // `default` serves `import https from "https"`; the spread serves
  // `import * as https from "https"`.
  return { ...api, default: api }
})
vi.mock("http", () => {
  net.factoryHits++
  const api = buildHttpModule()
  return { ...api, default: api }
})

function firstText(result: ToolResult): string {
  return result.content[0]?.type === "text" ? result.content[0].text : ""
}

const ctx = (): ToolContext => ({ config: {} }) as unknown as ToolContext

const call = async (tool: ReturnType<typeof createGithubTool>, args: Record<string, unknown>): Promise<ToolResult> =>
  tool.execute("t1", args, undefined, undefined, ctx())

beforeEach(() => {
  net.reset()
  vps.reset()
  // Clear any ambient token so "no token" paths are deterministic.
  vi.stubEnv("GITHUB_TOKEN", "")
  // Tokenless writes consult the VPS login (never api.github.com): default
  // logged-out 401 so refusal tests stay offline.
  vi.stubGlobal("fetch", async (url: unknown) => {
    const u = String(url)
    vps.calls.push(u)
    for (const [needle, spec] of vps.routes) {
      if (u.includes(needle)) return { status: spec.status, json: async () => spec.json }
    }
    return { status: 401, json: async () => ({ error: "GitHub login required — run /github login first" }) }
  })
  // Machine identity must not touch the real home dir.
  vi.stubEnv("TRAYAMBAK_MACHINE_ID_FILE", join(mkdtempSync(join(tmpdir(), "gh-tool-")), "machine-id"))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("parseRepo", () => {
  it("accepts owner/repo, full URLs, scheme-less host, and .git suffixes", () => {
    expect(parseRepo("owner/repo")).toEqual({ owner: "owner", repo: "repo" })
    expect(parseRepo("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" })
    expect(parseRepo("github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" })
    expect(parseRepo("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" })
  })

  it("rejects inputs without an owner/repo pair", () => {
    expect(parseRepo("just-a-repo")).toBeNull()
    expect(parseRepo("")).toBeNull()
    expect(parseRepo("https://gitlab.com/owner/repo")).toBeNull()
  })
})

describe("github guards", () => {
  it("rejects invalid repos, unknown actions, and missing parameters", async () => {
    const tool = createGithubTool()
    const badRepo = await call(tool, { repo: "nonsense", action: "get_tree" })
    expect(badRepo.isError).toBe(true)
    expect(firstText(badRepo)).toContain('github: invalid repo format "nonsense"')

    const badAction = await call(tool, { repo: "o/r", action: "deploy" })
    expect(badAction.isError).toBe(true)
    expect(firstText(badAction)).toContain('unknown action "deploy"')

    const noPath = await call(tool, { repo: "o/r", action: "read_files" })
    expect(noPath.isError).toBe(true)
    expect(firstText(noPath)).toBe("github: path is required for read_files.")

    const noCopyPaths = await call(tool, { repo: "o/r", action: "copy_files" })
    expect(noCopyPaths.isError).toBe(true)
    expect(firstText(noCopyPaths)).toBe("github: source_path and dest_path are required for copy_files.")

    expect(net.requests).toEqual([])
    // Both node:http and node:https must be routed through the canned mock —
    // anything else means the suite could hit the real network.
    expect(net.factoryHits).toBeGreaterThanOrEqual(2)
  })
})

describe("get_tree", () => {
  it("resolves the repository default branch instead of hardcoding main", async () => {
    // Trees route first: its URL also contains the "/repos/m/m" meta needle.
    net.routes.set("/git/trees/master", {
      status: 200,
      body: JSON.stringify({ tree: [{ path: "src", type: "tree", sha: "abc1234" }] }),
    })
    net.routes.set("/repos/m/m", { status: 200, body: JSON.stringify({ default_branch: "master" }) })
    const tool = createGithubTool()
    const res = await call(tool, { repo: "m/m", action: "get_tree" })
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(net.requests[0]).toBe("https://api.github.com/repos/m/m")
    expect(net.requests[1]).toContain("/git/trees/master?recursive=1")
    expect(net.requests.some((u) => u.includes("/git/trees/main"))).toBe(false)
    expect(text).toContain("📁 src (abc1234)")
  })

  it("surfaces a meta API failure (rate limit) without fetching the tree", async () => {
    net.routes.set("/repos/rl/r", {
      status: 403,
      body: JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }),
    })
    const tool = createGithubTool()
    const res = await call(tool, { repo: "rl/r", action: "get_tree" })
    expect(firstText(res)).toBe("github: API error for rl/r: HTTP 403 API rate limit exceeded for 1.2.3.4.")
    expect(net.requests).toHaveLength(1)
  })

  it("surfaces a branch-resolution failure from the trees endpoint", async () => {
    net.routes.set("/git/trees/develop", {
      status: 404,
      body: JSON.stringify({ message: "No commit found for develop on this branch." }),
    })
    net.routes.set("/repos/b/r", { status: 200, body: JSON.stringify({ default_branch: "develop" }) })
    const tool = createGithubTool()
    const res = await call(tool, { repo: "b/r", action: "get_tree" })
    expect(firstText(res)).toContain("No commit found for develop")
  })
})

describe("read_files", () => {
  it("encodes nested paths segment by segment (no %2F) and decodes content", async () => {
    net.routes.set("/contents/src/index.ts", {
      status: 200,
      body: JSON.stringify({ content: Buffer.from("export const a = 1\n").toString("base64") }),
    })
    const tool = createGithubTool()
    const res = await call(tool, { repo: "o/r", action: "read_files", path: "src/index.ts" })
    const text = firstText(res)
    expect(net.requests[0]).toBe("https://api.github.com/repos/o/r/contents/src/index.ts")
    expect(net.requests[0]).not.toContain("%2F")
    expect(text).toContain("--- src/index.ts ---")
    expect(text).toContain("export const a = 1")
  })

  it("surfaces HTTP errors, directories, and contentless blobs", async () => {
    net.routes.set("/contents/missing.ts", { status: 404, body: JSON.stringify({ message: "Not Found" }) })
    net.routes.set("/contents/dir", { status: 200, body: JSON.stringify([{ name: "inner.ts" }]) })
    net.routes.set("/contents/big.ts", { status: 200, body: JSON.stringify({ content: "", encoding: "none" }) })
    net.routes.set("/contents/flaky.ts", null)
    const tool = createGithubTool()

    const missing = await call(tool, { repo: "o/r", action: "read_files", path: "missing.ts" })
    expect(firstText(missing)).toContain("failed to fetch missing.ts")
    expect(firstText(missing)).toContain("404")
    expect(firstText(missing)).toContain("Not Found")

    const dir = await call(tool, { repo: "o/r", action: "read_files", path: "dir" })
    expect(firstText(dir)).toContain("github: dir is a directory (use get_tree to list it).")

    const big = await call(tool, { repo: "o/r", action: "read_files", path: "big.ts" })
    expect(firstText(big)).toContain("github: no content for big.ts")

    const flaky = await call(tool, { repo: "o/r", action: "read_files", path: "flaky.ts" })
    expect(firstText(flaky)).toContain("network error or timeout")
  })
})

describe("read_issue", () => {
  it("returns number, title, state, author, and body", async () => {
    net.routes.set("/repos/o/r/issues/1", {
      status: 200,
      body: JSON.stringify({
        number: 1,
        title: "HELLO",
        state: "open",
        user: { login: "someone" },
        body: "hello world",
        comments: 2,
        html_url: "https://github.com/o/r/issues/1",
      }),
    })
    const tool = createGithubTool()
    const res = await call(tool, { repo: "o/r", action: "read_issue", issue_number: 1 })
    const text = firstText(res)
    expect(net.requests[0]).toBe("https://api.github.com/repos/o/r/issues/1")
    expect(text).toContain("#1 [open] HELLO")
    expect(text).toContain("hello world")
  })

  it("requires issue_number and surfaces API failures honestly", async () => {
    const tool = createGithubTool()
    const missing = await call(tool, { repo: "o/r", action: "read_issue" })
    expect(missing.isError).toBe(true)
    expect(firstText(missing)).toBe("github: issue_number is required for read_issue.")

    net.routes.set("/repos/o/r/issues/9", { status: 404, body: JSON.stringify({ message: "Not Found" }) })
    const gone = await call(tool, { repo: "o/r", action: "read_issue", issue_number: "9" })
    expect(firstText(gone)).toContain("failed to read issue #9")
    expect(firstText(gone)).toContain("404")

    const badNum = await call(tool, { repo: "o/r", action: "read_issue", issue_number: "abc" })
    expect(firstText(badNum)).toContain('invalid issue number "abc"')
  })
})

describe("write_file", () => {
  it("creates missing files and updates existing ones (sha flow)", async () => {
    net.routes.set("/contents/new.md", [
      { status: 404, body: JSON.stringify({ message: "Not Found" }) },
      { status: 201, body: JSON.stringify({ commit: { sha: "aaa1111" } }) },
    ])
    net.routes.set("/contents/old.md", [
      { status: 200, body: JSON.stringify({ sha: "deadbee", type: "file" }) },
      { status: 200, body: JSON.stringify({ commit: { sha: "bbb2222" } }) },
    ])
    const tool = createGithubTool("tok")
    const created = await call(tool, { repo: "o/r", action: "write_file", path: "new.md", content: "hi" })
    expect(firstText(created)).toContain("github: wrote new.md in o/r (commit aaa1111)")
    const updated = await call(tool, {
      repo: "o/r",
      action: "write_file",
      path: "old.md",
      content: "v2",
      message: "bump",
    })
    expect(firstText(updated)).toContain("github: wrote old.md in o/r (commit bbb2222)")
  })

  it("routes tokenless writes through the VPS login, refusing with the login hint when logged out", async () => {
    const tool = createGithubTool()
    const loggedOut = await call(tool, { repo: "o/r", action: "write_file", path: "a.md", content: "x" })
    expect(loggedOut.isError).toBe(true)
    expect(firstText(loggedOut)).toContain("via your GitHub login failed")
    expect(firstText(loggedOut)).toContain("/github login")
    // api.github.com untouched — only the VPS saw this call.
    expect(net.requests).toEqual([])
    expect(vps.calls.some((u) => u.includes("/github/write"))).toBe(true)

    const keyed = createGithubTool("tok")
    expect(firstText(await call(keyed, { repo: "o/r", action: "write_file", content: "x" }))).toContain(
      "path is required",
    )
    expect(firstText(await call(keyed, { repo: "o/r", action: "write_file", path: "a.md" }))).toContain(
      "content is required",
    )
    expect(
      firstText(await call(keyed, { repo: "o/r", action: "write_file", path: "a.md", content: "x".repeat(100_001) })),
    ).toContain("over 100KB")
    net.routes.set("/contents/dir", { status: 200, body: JSON.stringify({ sha: "s", type: "dir" }) })
    expect(firstText(await call(keyed, { repo: "o/r", action: "write_file", path: "dir", content: "x" }))).toContain(
      "is not a file",
    )
    net.routes.set("/contents/denied.md", { status: 403, body: JSON.stringify({ message: "nope" }) })
    expect(
      firstText(await call(keyed, { repo: "o/r", action: "write_file", path: "denied.md", content: "x" })),
    ).toContain("failed to check denied.md")
  })

  it("writes through the VPS when logged in (no local token)", async () => {
    vps.routes.set("/github/write", { status: 200, json: { ok: true, commit: "aaa1111" } })
    const tool = createGithubTool()
    const res = await call(tool, { repo: "o/r", action: "write_file", path: "new.md", content: "hi" })
    expect(res.isError).toBe(false)
    expect(firstText(res)).toContain("github: wrote new.md in o/r (commit aaa1111) (via your GitHub login)")
    expect(net.requests).toEqual([])
  })
})

describe("create_branch and create_pr", () => {
  it("creates a branch off the default and opens a PR", async () => {
    // Specific needles first: every URL also contains "/repos/o/r".
    net.routes.set("/git/ref/heads/main", { status: 200, body: JSON.stringify({ object: { sha: "abc123" } }) })
    net.routes.set("/git/refs", { status: 201, body: JSON.stringify({ ref: "refs/heads/trayambak/issue-1" }) })
    net.routes.set("/pulls", {
      status: 201,
      body: JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7" }),
    })
    net.routes.set("/repos/o/r", { status: 200, body: JSON.stringify({ default_branch: "main" }) })
    const tool = createGithubTool("tok")
    const br = await call(tool, { repo: "o/r", action: "create_branch", branch: "trayambak/issue-1" })
    expect(firstText(br)).toContain("github: created branch trayambak/issue-1 off main")
    const pr = await call(tool, {
      repo: "o/r",
      action: "create_pr",
      branch: "trayambak/issue-1",
      title: "Fix #1",
      body: "auto",
    })
    expect(firstText(pr)).toContain("github: opened PR #7")
  })

  it("routes tokenless branch/PR calls through the VPS login, plus the direct guards", async () => {
    const tool = createGithubTool()
    expect(firstText(await call(tool, { repo: "o/r", action: "create_branch", branch: "x" }))).toContain(
      "via your GitHub login failed",
    )
    expect(firstText(await call(tool, { repo: "o/r", action: "create_pr", branch: "x", title: "t" }))).toContain(
      "via your GitHub login failed",
    )
    expect(net.requests).toEqual([])
    const keyed = createGithubTool("tok")
    expect(firstText(await call(keyed, { repo: "o/r", action: "create_branch" }))).toContain("branch is required")
    expect(firstText(await call(keyed, { repo: "o/r", action: "create_branch", branch: "../evil" }))).toContain(
      "invalid branch name",
    )
    expect(firstText(await call(keyed, { repo: "o/r", action: "create_pr", branch: "x" }))).toContain(
      "branch (head) and title are required",
    )
    net.routes.set("/git/refs", { status: 422, body: JSON.stringify({ message: "Reference already exists" }) })
    net.routes.set("/git/ref/heads/main", { status: 200, body: JSON.stringify({ object: { sha: "abc123" } }) })
    net.routes.set("/repos/o/r", { status: 200, body: JSON.stringify({ default_branch: "main" }) })
    expect(firstText(await call(keyed, { repo: "o/r", action: "create_branch", branch: "taken" }))).toContain(
      "already exists",
    )
  })
})

describe("compare", () => {
  it("lists changes, reports no-change diffs, and surfaces API failures", async () => {
    net.routes.set("/compare/main...feature", {
      status: 200,
      body: JSON.stringify({ files: [{ filename: "a.ts", changes: 3, status: "modified" }] }),
    })
    net.routes.set("/compare/main...HEAD", { status: 200, body: JSON.stringify({ files: [] }) })
    net.routes.set("/compare/x...y", { status: 403, body: JSON.stringify({ message: "bad credentials" }) })
    const tool = createGithubTool()

    const changed = await call(tool, { repo: "o/r", action: "compare", base: "main", head: "feature" })
    expect(firstText(changed)).toContain("github compare o/r: main...feature")
    expect(firstText(changed)).toContain("modified a.ts (+3)")

    const none = await call(tool, { repo: "o/r", action: "compare", base: "main", head: "HEAD" })
    expect(firstText(none)).toContain("(no changes)")

    const failed = await call(tool, { repo: "o/r", action: "compare", base: "x", head: "y" })
    expect(firstText(failed)).toContain("failed to compare x...y: HTTP 403 bad credentials")
  })
})

describe("copy_files", () => {
  it("consults the VPS when tokenless and surfaces the login hint when logged out", async () => {
    const tool = createGithubTool()
    const res = await call(tool, { repo: "o/r", action: "copy_files", source_path: "a", dest_path: "b" })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("via your GitHub login failed")
    expect(firstText(res)).toContain("/github login")
    // api.github.com untouched — the login check went to the VPS only.
    expect(net.requests).toEqual([])
    expect(vps.calls.some((u) => u.includes("/github/copy"))).toBe(true)
  })

  it("copies through the VPS when logged in (no local token)", async () => {
    vps.routes.set("/github/copy", { status: 200, json: { ok: true, commit: "deadbee" } })
    const tool = createGithubTool()
    const res = await call(tool, {
      repo: "o/r",
      action: "copy_files",
      source_path: "src/hello.txt",
      dest_path: "dir/out.txt",
    })
    expect(res.isError).toBe(false)
    expect(firstText(res)).toContain("github: copied src/hello.txt -> dir/out.txt in o/r (commit deadbee)")
    expect(net.requests).toEqual([])
  })

  it("performs the real GET/GET/PUT copy flow when a token is available", async () => {
    // Dest route first: GET sees 404 (new file), the PUT on the same path then
    // sees 201 — the array is consumed in order.
    net.routes.set("/contents/dir/out.txt", [
      { status: 404, body: JSON.stringify({ message: "Not Found" }) },
      { status: 201, body: JSON.stringify({ commit: { sha: "deadbeefcafe123456" } }) },
    ])
    net.routes.set("/contents/src/hello.txt", {
      status: 200,
      body: JSON.stringify({ content: Buffer.from("hello world").toString("base64") }),
    })
    const tool = createGithubTool("tok-123")
    const res = await call(tool, {
      repo: "o/r",
      action: "copy_files",
      source_path: "src/hello.txt",
      dest_path: "dir/out.txt",
    })
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("github: copied src/hello.txt -> dir/out.txt in o/r")
    expect(text).toContain("(commit deadbee)")
    expect(net.methods).toEqual(["GET", "GET", "PUT"])
    expect(net.headers[0]["Authorization"]).toBe("Bearer tok-123")
    expect(net.headers[2]["Content-Type"]).toBe("application/json")
    expect(net.writes).toHaveLength(1)
    const putBody = JSON.parse(net.writes[0]) as { message?: string; content?: string; sha?: string }
    expect(putBody.message).toBe("trayambak: copy src/hello.txt -> dir/out.txt")
    expect(putBody.content).toBe(Buffer.from("hello world").toString("base64"))
    expect(putBody.sha).toBeUndefined()
    expect(net.requests[2]).toBe("https://api.github.com/repos/o/r/contents/dir/out.txt")
  })

  it("carries the existing destination sha when overwriting", async () => {
    net.routes.set("/contents/old.txt", {
      status: 200,
      body: JSON.stringify({ content: Buffer.from("src-data").toString("base64") }),
    })
    net.routes.set("/contents/new.txt", [
      { status: 200, body: JSON.stringify({ sha: "dest-sha-000" }) },
      { status: 201, body: JSON.stringify({ commit: { sha: "aaaabbbbcccc0000" } }) },
    ])
    const tool = createGithubTool("tok-123")
    const res = await call(tool, {
      repo: "o/r",
      action: "copy_files",
      source_path: "old.txt",
      dest_path: "new.txt",
    })
    expect(firstText(res)).toContain("copied old.txt -> new.txt")
    expect(net.methods).toEqual(["GET", "GET", "PUT"])
    const putBody = JSON.parse(net.writes[0]) as { sha?: string; content?: string }
    expect(putBody.sha).toBe("dest-sha-000")
    expect(putBody.content).toBe(Buffer.from("src-data").toString("base64"))
  })
})

describe("list_repos", () => {
  it("lists repos direct with a token", async () => {
    net.routes.set("/user/repos", {
      status: 200,
      body: JSON.stringify([
        { full_name: "octocat/mytest1", private: false, default_branch: "main" },
        { full_name: "octocat/secret", private: true, default_branch: "master" },
      ]),
    })
    const tool = createGithubTool("tok")
    const res = await call(tool, { repo: "o/r", action: "list_repos" })
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("octocat/mytest1")
    expect(text).toContain("octocat/secret")
    expect(net.headers[0]["Authorization"]).toBe("Bearer tok")
  })

  it("lists repos through the VPS login when tokenless", async () => {
    vps.routes.set("/github/repos", {
      status: 200,
      json: {
        ok: true,
        login: "octocat",
        repos: [{ fullName: "octocat/mytest1", private: false, defaultBranch: "main" }],
      },
    })
    const tool = createGithubTool()
    const res = await call(tool, { repo: "o/r", action: "list_repos" })
    const text = firstText(res)
    expect(res.isError).toBe(false)
    expect(text).toContain("github repos for @octocat (1)")
    expect(text).toContain("octocat/mytest1")
    expect(net.requests).toEqual([])
  })

  it("surfaces the login hint when logged out and tokenless", async () => {
    const tool = createGithubTool()
    const res = await call(tool, { repo: "o/r", action: "list_repos" })
    expect(res.isError).toBe(true)
    expect(firstText(res)).toContain("/github login")
  })
})
