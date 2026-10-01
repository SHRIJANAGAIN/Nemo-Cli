/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import https from "https"
import http from "http"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import {
  copyGithubFileViaServer,
  createGithubBranchViaServer,
  createGithubPrViaServer,
  listGithubRepos,
  writeGithubFileViaServer,
} from "../../github-auth.js"

const GH_API = "https://api.github.com"

type GhReply = { status: number; body: string }

/** Encode a contents-API path segment by segment. encodeURIComponent() over
 *  the whole path turns `src/x.ts` into `src%2Fx.ts`, which the contents API
 *  resolves as a single literal segment and 404s on every nested file. */
function encodeContentPath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")
}

/** Best-effort `message` from a GitHub error body ("" when unparseable). */
function apiMessage(body: string): string {
  try {
    return (JSON.parse(body) as { message?: string }).message ?? ""
  } catch {
    return ""
  }
}

/** Raw failure tail (no license prefix) describing a non-2xx/failed reply. */
function describeFailure(label: string, reply: GhReply): string {
  if (reply.status === 0) return `request failed for ${label} (network error or timeout)`
  const msg = apiMessage(reply.body)
  return `API error for ${label}: HTTP ${reply.status}${msg ? ` ${msg}` : ""}`
}

function ghRequest(path: string, token?: string, method?: string, payload?: string): Promise<GhReply> {
  return new Promise((resolve) => {
    const url = new URL(GH_API + path)
    const lib = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = {
      "User-Agent": "trayambak",
      Accept: "application/vnd.github+json",
    }
    if (token) headers["Authorization"] = `Bearer ${token}`
    const done = (status: number, body: string): void => resolve({ status, body })
    const onResp = (res: { statusCode?: number; on: (ev: string, cb: (c?: Buffer) => void) => unknown }): void => {
      const chunks: Buffer[] = []
      const status = res.statusCode ?? 0
      res.on("data", (c) => chunks.push(c as Buffer))
      res.on("end", () => done(status, Buffer.concat(chunks).toString("utf8")))
      res.on("error", () => done(status, ""))
    }
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json"
      headers["Content-Length"] = String(Buffer.byteLength(payload))
      const req = lib.request(url.toString(), { method: method ?? "POST", headers }, onResp)
      req.on("error", () => done(0, ""))
      req.setTimeout(15000, () => {
        req.destroy()
        done(0, "")
      })
      req.write(payload)
      req.end()
    } else {
      const req = lib.get(url.toString(), { headers }, onResp)
      req.on("error", () => done(0, ""))
      req.setTimeout(15000, () => {
        req.destroy()
        done(0, "")
      })
    }
  })
}

function parseRepo(input: string): { owner: string; repo: string } | null {
  // Strip the host so `github.com/owner/repo` (no scheme) parses the same as
  // the full URL — the old regex read `github.com` as the owner.
  const cleaned = input.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
  const m = cleaned.match(/^(?<owner>[^/]+)\/(?<repo>[^/?#]+)/)
  if (!m) return null
  return { owner: m.groups!.owner, repo: m.groups!.repo.replace(/\.git$/, "") }
}

async function githubGetTree(owner: string, repo: string, token?: string): Promise<string> {
  // Resolve the real default branch first: hardcoding `main` 404s on every
  // master-based repo, and a 404 body used to surface as "empty tree".
  const meta = await ghRequest(`/repos/${owner}/${repo}`, token)
  if (meta.status < 200 || meta.status >= 300) return `github: ${describeFailure(`${owner}/${repo}`, meta)}`
  let branch = "main"
  try {
    const parsed = JSON.parse(meta.body) as { default_branch?: string }
    if (parsed.default_branch) branch = parsed.default_branch
  } catch {
    /* fall back to main */
  }
  const raw = await ghRequest(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token)
  if (raw.status < 200 || raw.status >= 300) return `github: ${describeFailure(`${owner}/${repo}`, raw)}`
  if (!raw.body) return `github: failed to fetch tree for ${owner}/${repo}`
  try {
    const data = JSON.parse(raw.body) as {
      message?: string
      tree?: Array<{ path?: string; type?: string; sha?: string }>
    }
    if (data.message) return `github: API error for ${owner}/${repo}: ${data.message}`
    const tree = data.tree ?? []
    if (tree.length === 0) return `github: empty tree for ${owner}/${repo}`
    const lines = tree.map((item) => `  ${item.type === "tree" ? "📁" : "📄"} ${item.path} (${item.sha})`)
    return `github tree for ${owner}/${repo} (${tree.length} items):\n${lines.join("\n")}`
  } catch {
    return `github: invalid response for tree ${owner}/${repo}`
  }
}

async function githubReadFiles(owner: string, repo: string, paths: string[], token?: string): Promise<string> {
  const out: string[] = []
  for (const p of paths) {
    const reply = await ghRequest(`/repos/${owner}/${repo}/contents/${encodeContentPath(p)}`, token)
    if (reply.status < 200 || reply.status >= 300) {
      out.push(`github: failed to fetch ${p}: ${describeFailure(p, reply)}`)
      continue
    }
    if (!reply.body) {
      out.push(`github: failed to fetch ${p} (empty response)`)
      continue
    }
    try {
      const data = JSON.parse(reply.body)
      if (Array.isArray(data)) {
        out.push(`github: ${p} is a directory (use get_tree to list it).`)
      } else if (data.content) {
        const content = Buffer.from(data.content, "base64").toString("utf8")
        out.push(`--- ${p} ---\n${content}`)
      } else {
        out.push(`github: no content for ${p}`)
      }
    } catch {
      out.push(`github: invalid response for ${p}`)
    }
  }
  return out.join("\n\n")
}

/** Read one issue (or PR — the issues endpoint serves both): number,
 *  title, state, author, body, comment count. The agent's only way to see
 *  WHAT it was asked about; without this it works blind and reports phantom
 *  404s (observed live on a public repo). Works unauthenticated for public
 *  repos, token extends it to private ones. */
async function githubReadIssue(owner: string, repo: string, num: string, token?: string): Promise<string> {
  if (!/^\d+$/.test(num)) return `github: invalid issue number "${num}".`
  const reply = await ghRequest(`/repos/${owner}/${repo}/issues/${num}`, token)
  if (reply.status < 200 || reply.status >= 300) {
    return `github: failed to read issue #${num}: ${describeFailure(`#${num}`, reply)}`
  }
  if (!reply.body) return `github: failed to read issue #${num} (empty response)`
  try {
    const data = JSON.parse(reply.body) as {
      message?: string
      number?: number
      title?: string
      state?: string
      user?: { login?: string }
      body?: string | null
      comments?: number
      html_url?: string
      pull_request?: unknown
    }
    if (data.message) return `github: API error for #${num}: ${data.message}`
    const body = (data.body ?? "").slice(0, 4000)
    const kind = data.pull_request !== undefined ? "pull request" : "issue"
    return (
      `github ${kind} #${data.number ?? num} [${data.state ?? "?"}] ${data.title ?? "(no title)"}\n` +
      `author: ${data.user?.login ?? "?"} · comments: ${data.comments ?? 0} · ${data.html_url ?? ""}\n` +
      `--- body ---\n${body || "(empty)"}`
    )
  } catch {
    return `github: invalid issue response for #${num}`
  }
}

/** Direct file write: create or update a text file in one call (GET for the
 *  current sha when the file exists, then PUT). This is what lets the bot
 *  actually fix things instead of only describing fixes. Needs a write
 *  token (installation token with Contents write, or a PAT). Content cap:
 *  100KB per write so a runaway model cannot paste megabytes into a repo. */
async function githubWriteFile(
  owner: string,
  repo: string,
  filePath: string,
  content: string,
  message: string,
  token?: string,
  branch?: string,
): Promise<string> {
  if (Buffer.byteLength(content, "utf8") > 100_000) {
    return `github: refusing to write ${filePath} (over 100KB — split it or use a PR).`
  }
  let sha: string | undefined
  const existing = await ghRequest(
    `/repos/${owner}/${repo}/contents/${encodeContentPath(filePath)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`,
    token,
  )
  if (existing.status >= 200 && existing.status < 300) {
    try {
      const parsed = JSON.parse(existing.body) as { sha?: string; type?: string }
      if (parsed.type !== "file") return `github: ${filePath} exists but is not a file — refusing to overwrite.`
      sha = parsed.sha
    } catch {
      /* overwrite without a sha will fail below with a clear API message */
    }
  } else if (existing.status !== 404) {
    return `github: failed to check ${filePath}: ${describeFailure(filePath, existing)}`
  }
  const putBody = JSON.stringify({
    message: message || `trayambak: update ${filePath}`,
    content: Buffer.from(content, "utf8").toString("base64"),
    ...(sha ? { sha } : {}),
    ...(branch ? { branch } : {}),
  })
  const put = await ghRequest(`/repos/${owner}/${repo}/contents/${encodeContentPath(filePath)}`, token, "PUT", putBody)
  if (put.status < 200 || put.status >= 300)
    return `github: failed to write ${filePath}: ${describeFailure(filePath, put)}`
  let commit = ""
  try {
    const parsed = JSON.parse(put.body) as { commit?: { sha?: string } }
    commit = parsed.commit?.sha ? ` (commit ${parsed.commit.sha.slice(0, 7)})` : ""
  } catch {
    /* commit sha is cosmetic */
  }
  return `github: wrote ${filePath} in ${owner}/${repo}${commit}`
}

/** Create a branch off the base (default branch when omitted). The autofix
 *  loop's first step: every fix lands on `trayambak/issue-N`, never main. */
async function githubCreateBranch(
  owner: string,
  repo: string,
  branch: string,
  base: string | undefined,
  token?: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,120}$/.test(branch)) return `github: invalid branch name "${branch}".`
  const meta = await ghRequest(`/repos/${owner}/${repo}`, token)
  if (meta.status < 200 || meta.status >= 300) return `github: ${describeFailure(`${owner}/${repo}`, meta)}`
  let baseBranch = base?.trim() || ""
  if (!baseBranch) {
    try {
      baseBranch = (JSON.parse(meta.body) as { default_branch?: string }).default_branch ?? "main"
    } catch {
      baseBranch = "main"
    }
  }
  const ref = await ghRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`, token)
  if (ref.status < 200 || ref.status >= 300)
    return `github: failed to resolve base ${baseBranch}: ${describeFailure(baseBranch, ref)}`
  let baseSha = ""
  try {
    baseSha = (JSON.parse(ref.body) as { object?: { sha?: string } }).object?.sha ?? ""
  } catch {
    /* falls into the empty check below */
  }
  if (!baseSha) return `github: could not find sha for base ${baseBranch}`
  const created = await ghRequest(
    `/repos/${owner}/${repo}/git/refs`,
    token,
    "POST",
    JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  )
  if (created.status === 422) return `github: branch ${branch} already exists — write onto it directly.`
  if (created.status < 200 || created.status >= 300)
    return `github: failed to create branch ${branch}: ${describeFailure(branch, created)}`
  return `github: created branch ${branch} off ${baseBranch} in ${owner}/${repo}`
}

/** Open a pull request. The autofix loop's last step: human merges. */
async function githubCreatePr(
  owner: string,
  repo: string,
  head: string,
  base: string | undefined,
  title: string,
  body: string,
  token?: string,
): Promise<string> {
  if (!head.trim()) return `github: head branch is required for create_pr.`
  if (!title.trim()) return `github: title is required for create_pr.`
  const created = await ghRequest(
    `/repos/${owner}/${repo}/pulls`,
    token,
    "POST",
    JSON.stringify({ title: title.slice(0, 200), head, base: base?.trim() || undefined, body: body.slice(0, 8000) }),
  )
  if (created.status < 200 || created.status >= 300)
    return `github: failed to open PR: ${describeFailure(`${head}`, created)}`
  try {
    const parsed = JSON.parse(created.body) as { html_url?: string; number?: number }
    return `github: opened PR #${parsed.number ?? "?"} ${parsed.html_url ?? ""}`
  } catch {
    return `github: PR opened (unreadable response)`
  }
}

/** Real copy: read the source blob from the default branch, then PUT it to
 *  the destination. The old implementation returned a "requires write token"
 *  string while reporting success, so copy_files never copied anything. */
async function githubCopyFiles(
  owner: string,
  repo: string,
  sourcePath: string,
  destPath: string,
  token?: string,
): Promise<string> {
  const src = await ghRequest(`/repos/${owner}/${repo}/contents/${encodeContentPath(sourcePath)}`, token)
  if (src.status < 200 || src.status >= 300)
    return `github: failed to read ${sourcePath}: ${describeFailure(sourcePath, src)}`
  let source: { content?: string; encoding?: string }
  try {
    const parsed = JSON.parse(src.body) as { content?: string; encoding?: string }
    if (!parsed.content) return `github: ${sourcePath} has no retrievable content (too large for the contents API?)`
    source = parsed
  } catch {
    return `github: invalid response reading ${sourcePath}`
  }
  // Re-encode from decoded text so the PUT body never carries GitHub's
  // embedded newlines.
  const b64 = Buffer.from(Buffer.from(source.content ?? "", "base64").toString("utf8"), "utf8").toString("base64")

  let sha: string | undefined
  const existing = await ghRequest(`/repos/${owner}/${repo}/contents/${encodeContentPath(destPath)}`, token)
  if (existing.status >= 200 && existing.status < 300) {
    try {
      const parsed = JSON.parse(existing.body) as { sha?: string }
      sha = parsed.sha
    } catch {
      /* overwrite without a sha will fail below with a clear API message */
    }
  }

  const putBody = JSON.stringify({
    message: `trayambak: copy ${sourcePath} -> ${destPath}`,
    content: b64,
    ...(sha ? { sha } : {}),
  })
  const put = await ghRequest(`/repos/${owner}/${repo}/contents/${encodeContentPath(destPath)}`, token, "PUT", putBody)
  if (put.status < 200 || put.status >= 300)
    return `github: failed to write ${destPath}: ${describeFailure(destPath, put)}`
  let commit = ""
  try {
    const parsed = JSON.parse(put.body) as { commit?: { sha?: string } }
    commit = parsed.commit?.sha ? ` (commit ${parsed.commit.sha.slice(0, 7)})` : ""
  } catch {
    /* commit sha is cosmetic */
  }
  return `github: copied ${sourcePath} -> ${destPath} in ${owner}/${repo}${commit}`
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "github",
  description:
    "Interact with GitHub repositories: read an issue/PR, list files, read/write files, copy files, compare branches, list your own repos. Reads work unauthenticated for public repos (a token extends them to private ones); writes ride your /github login through the VPS automatically when no GITHUB_TOKEN is set — never ask the user to paste a token.",
  parameters: {
    type: "object",
    required: ["repo", "action"],
    properties: {
      repo: { type: "string", description: "GitHub repository in owner/repo format or full URL" },
      action: {
        type: "string",
        description: "GitHub action",
        enum: [
          "read_issue",
          "get_tree",
          "read_files",
          "write_file",
          "create_branch",
          "create_pr",
          "copy_files",
          "compare",
          "list_repos",
        ],
      },
      issue_number: { type: "string", description: "Issue/PR number for read_issue" },
      content: { type: "string", description: "File content for write_file" },
      message: { type: "string", description: "Commit message for write_file" },
      branch: {
        type: "string",
        description: "Branch for write_file (must exist — see create_branch), or head for create_pr",
      },
      base: {
        type: "string",
        description: "Base branch (create_branch/create_pr default: repo default; compare default: main)",
      },
      title: { type: "string", description: "PR title for create_pr" },
      body: { type: "string", description: "PR body for create_pr" },
      path: { type: "string", description: "File path(s) for read_files action, comma-separated" },
      source_path: { type: "string", description: "Source path for copy_files" },
      dest_path: { type: "string", description: "Destination path for copy_files" },
      head: { type: "string", description: "Head branch/commit for compare" },
    },
  },
}

export function createGithubTool(token?: string): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context: ToolContext) {
      const ctx = context as ToolContext & { githubToken?: string }
      const ghToken = ctx.githubToken ?? token ?? process.env.GITHUB_TOKEN
      // VPS-routed writes: the CLI never holds the OAuth token, so when no
      // local token exists the write actions ride the stored /github login
      // through the license server (machine-bound, token never leaves the
      // VPS). serverUrl comes from the agent config (boot loadConfig).
      const serverOpts = { serverUrl: ctx?.config?.licenseServerUrl }
      const repoInput = String(args.repo ?? "")
      const action = String(args.action ?? "")
      const parsed = parseRepo(repoInput)
      if (!parsed)
        return textResult(
          `github: invalid repo format "${repoInput}". Use owner/repo or full GitHub URL.`,
          /*isError*/ true,
        )
      const { owner, repo } = parsed
      switch (action) {
        case "read_issue": {
          const num = String(args.issue_number ?? "").trim()
          if (!num) return textResult("github: issue_number is required for read_issue.", /*isError*/ true)
          return textResult(await githubReadIssue(owner, repo, num, ghToken))
        }
        case "write_file": {
          const filePath = String(args.path ?? "").trim()
          const content = typeof args.content === "string" ? args.content : ""
          if (!filePath) return textResult("github: path is required for write_file.", /*isError*/ true)
          if (!content) return textResult("github: content is required for write_file.", /*isError*/ true)
          const msg = typeof args.message === "string" ? args.message : ""
          const wbranch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined
          if (!ghToken) {
            const r = await writeGithubFileViaServer(repoInput, filePath, content, msg, wbranch, serverOpts)
            if (!r.ok)
              return textResult(
                `github: write_file via your GitHub login failed — ${r.reason} (or set GITHUB_TOKEN).`,
                /*isError*/ true,
              )
            return textResult(
              `github: wrote ${filePath} in ${owner}/${repo}${r.commit ? ` (commit ${r.commit})` : ""} (via your GitHub login)`,
            )
          }
          return textResult(await githubWriteFile(owner, repo, filePath, content, msg, ghToken, wbranch))
        }
        case "create_branch": {
          const branch = String(args.branch ?? "").trim()
          if (!branch) return textResult("github: branch is required for create_branch.", /*isError*/ true)
          const base = typeof args.base === "string" ? args.base : undefined
          if (!ghToken) {
            const r = await createGithubBranchViaServer(repoInput, branch, base, serverOpts)
            if (!r.ok)
              return textResult(
                `github: create_branch via your GitHub login failed — ${r.reason} (or set GITHUB_TOKEN).`,
                /*isError*/ true,
              )
            return textResult(
              `github: created branch ${branch} off ${r.base ?? "default"} in ${owner}/${repo} (via your GitHub login)`,
            )
          }
          return textResult(await githubCreateBranch(owner, repo, branch, base, ghToken))
        }
        case "create_pr": {
          const head = String(args.branch ?? "").trim()
          const title = typeof args.title === "string" ? args.title : ""
          if (!head || !title)
            return textResult("github: branch (head) and title are required for create_pr.", /*isError*/ true)
          const base = typeof args.base === "string" ? args.base : undefined
          const body = typeof args.body === "string" ? args.body : ""
          if (!ghToken) {
            const r = await createGithubPrViaServer(repoInput, head, base, title, body, serverOpts)
            if (!r.ok)
              return textResult(
                `github: create_pr via your GitHub login failed — ${r.reason} (or set GITHUB_TOKEN).`,
                /*isError*/ true,
              )
            return textResult(`github: opened PR #${r.number ?? "?"} ${r.url ?? ""} (via your GitHub login)`)
          }
          return textResult(await githubCreatePr(owner, repo, head, base, title, body, ghToken))
        }
        case "get_tree":
          return textResult(await githubGetTree(owner, repo, ghToken))
        case "read_files": {
          const paths = String(args.path ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
          if (paths.length === 0) return textResult("github: path is required for read_files.", /*isError*/ true)
          return textResult(await githubReadFiles(owner, repo, paths, ghToken))
        }
        case "copy_files": {
          const source = String(args.source_path ?? "")
          const dest = String(args.dest_path ?? "")
          if (!source || !dest)
            return textResult("github: source_path and dest_path are required for copy_files.", /*isError*/ true)
          if (!ghToken) {
            const r = await copyGithubFileViaServer(repoInput, source, dest, serverOpts)
            if (!r.ok)
              return textResult(
                `github: copy_files via your GitHub login failed — ${r.reason} (or set GITHUB_TOKEN).`,
                /*isError*/ true,
              )
            return textResult(
              `github: copied ${source} -> ${dest} in ${owner}/${repo}${r.commit ? ` (commit ${r.commit})` : ""} (via your GitHub login)`,
            )
          }
          return textResult(await githubCopyFiles(owner, repo, source, dest, ghToken))
        }
        case "list_repos": {
          // Your repos, by your handle: direct API when a token exists,
          // otherwise the VPS rides the stored /github login.
          if (ghToken) {
            const reply = await ghRequest(`/user/repos?per_page=100&sort=updated`, ghToken)
            if (reply.status < 200 || reply.status >= 300)
              return textResult(`github: failed to list repos: ${describeFailure("repos", reply)}`)
            try {
              const data = JSON.parse(reply.body) as Array<{
                full_name?: string
                private?: boolean
                default_branch?: string
                updated_at?: string
              }>
              const lines = data
                .filter((r) => typeof r.full_name === "string")
                .map(
                  (r) =>
                    `  ${r.private === true ? "🔒" : "🌐"} ${r.full_name} (default: ${r.default_branch ?? "main"})`,
                )
              return textResult(`github repos (${lines.length}):\n${lines.join("\n") || "  (none)"}`)
            } catch {
              return textResult("github: invalid repo-list response")
            }
          }
          const r = await listGithubRepos(serverOpts)
          if (!r.ok)
            return textResult(`github: list_repos failed — ${r.reason} (or set GITHUB_TOKEN).`, /*isError*/ true)
          const lines = (r.repos ?? []).map(
            (x) => `  ${x.private ? "🔒" : "🌐"} ${x.fullName} (default: ${x.defaultBranch || "main"})`,
          )
          return textResult(`github repos for @${r.login ?? "?"} (${lines.length}):\n${lines.join("\n") || "  (none)"}`)
        }
        case "compare": {
          const base = String(args.base ?? "main")
          const head = String(args.head ?? "HEAD")
          const reply = await ghRequest(`/repos/${owner}/${repo}/compare/${base}...${head}`, ghToken)
          if (reply.status < 200 || reply.status >= 300) {
            if (reply.status === 0)
              return textResult(`github: failed to compare ${base}...${head} (network error or timeout)`)
            const errMsg = apiMessage(reply.body)
            return textResult(
              `github: failed to compare ${base}...${head}: HTTP ${reply.status}${errMsg ? ` ${errMsg}` : ""}`,
            )
          }
          if (!reply.body) return textResult(`github: failed to compare ${base}...${head} in ${owner}/${repo}`)
          try {
            const data = JSON.parse(reply.body) as {
              message?: string
              files?: Array<{ filename?: string; changes?: number; status?: string }>
            }
            if (data.message) return textResult(`github: failed to compare ${base}...${head}: ${data.message}`)
            const files = (data.files ?? []).map((f) => `  ${f.status} ${f.filename} (+${f.changes ?? 0})`).join("\n")
            return textResult(`github compare ${owner}/${repo}: ${base}...${head}\n${files || "  (no changes)"}`)
          } catch {
            return textResult(`github: invalid compare response for ${owner}/${repo}`)
          }
        }
        default:
          return textResult(
            `github: unknown action "${action}". Use read_issue, get_tree, read_files, write_file, create_branch, create_pr, copy_files, compare, or list_repos.`,
            /*isError*/ true,
          )
      }
    },
  }
}

export { parseRepo }
