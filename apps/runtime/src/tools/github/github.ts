/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import https from "https"
import http from "http"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"

const GH_API = "https://api.github.com"

function ghRequest(path: string, token?: string): Promise<string> {
  return new Promise((resolve) => {
    const url = new URL(GH_API + path)
    const lib = url.protocol === "https:" ? https : http
    const headers: Record<string, string> = {
      "User-Agent": "trayambak",
      Accept: "application/vnd.github+json",
    }
    if (token) headers["Authorization"] = `Bearer ${token}`
    const req = lib.get(url.toString(), { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      res.on("error", () => resolve(""))
    })
    req.on("error", () => resolve(""))
    req.setTimeout(15000, () => {
      req.destroy()
      resolve("")
    })
  })
}

function parseRepo(input: string): { owner: string; repo: string } | null {
  const m = input.match(/^(https?:\/\/github\.com\/)?(?<owner>[^/]+)\/(?<repo>[^/?#]+)/)
  if (!m) return null
  return { owner: m.groups!.owner, repo: m.groups!.repo.replace(/\.git$/, "") }
}

function githubGetTree(owner: string, repo: string, token?: string): Promise<string> {
  return ghRequest(`/repos/${owner}/${repo}/git/trees/main?recursive=1`, token).then((raw) => {
    if (!raw) return `github: failed to fetch tree for ${owner}/${repo}`
    try {
      const data = JSON.parse(raw)
      const tree = data.tree ?? []
      if (tree.length === 0) return `github: empty tree for ${owner}/${repo}`
      const lines = tree.map(
        (item: { path?: string; type?: string; sha?: string }) =>
          `  ${item.type === "tree" ? "📁" : "📄"} ${item.path} (${item.sha})`,
      )
      return `github tree for ${owner}/${repo} (${tree.length} items):\n${lines.join("\n")}`
    } catch {
      return `github: invalid response for tree ${owner}/${repo}`
    }
  })
}

function githubReadFiles(owner: string, repo: string, paths: string[], token?: string): Promise<string> {
  return Promise.all(
    paths.map((p) => ghRequest(`/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}`, token)),
  ).then((results) => {
    const out: string[] = []
    for (let i = 0; i < results.length; i++) {
      const raw = results[i]
      if (!raw) {
        out.push(`github: failed to fetch ${paths[i]}`)
        continue
      }
      try {
        const data = JSON.parse(raw)
        if (data.content) {
          const content = Buffer.from(data.content, "base64").toString("utf8")
          out.push(`--- ${paths[i]} ---\n${content}`)
        } else {
          out.push(`github: no content for ${paths[i]}`)
        }
      } catch {
        out.push(`github: invalid response for ${paths[i]}`)
      }
    }
    return out.join("\n\n")
  })
}

function githubCopyFiles(owner: string, repo: string, sourcePath: string, destPath: string): Promise<string> {
  return Promise.resolve(`github: copy from ${sourcePath} to ${destPath} in ${owner}/${repo} (requires write token)`)
}

function githubCompare(owner: string, repo: string, base: string, head: string, token?: string): Promise<string> {
  return ghRequest(`/repos/${owner}/${repo}/compare/${base}...${head}`, token).then((raw) => {
    if (!raw) return `github: failed to compare ${base}...${head} in ${owner}/${repo}`
    try {
      const data = JSON.parse(raw)
      const files = (data.files ?? [])
        .map(
          (f: { filename?: string; changes?: number; status?: string }) =>
            `  ${f.status} ${f.filename} (+${f.changes ?? 0})`,
        )
        .join("\n")
      return `github compare ${owner}/${repo}: ${base}...${head}\n${files || "  (no changes)"}`
    } catch {
      return `github: invalid compare response for ${owner}/${repo}`
    }
  })
}

const definition: ToolDefinition = {
  name: "github",
  description:
    "Interact with GitHub repositories: list files, read files, copy files, compare branches. Use this for GitHub-related tasks.",
  parameters: {
    type: "object",
    required: ["repo", "action"],
    properties: {
      repo: { type: "string", description: "GitHub repository in owner/repo format or full URL" },
      action: {
        type: "string",
        description: "GitHub action",
        enum: ["get_tree", "read_files", "copy_files", "compare"],
      },
      path: { type: "string", description: "File path(s) for read_files action, comma-separated" },
      source_path: { type: "string", description: "Source path for copy_files" },
      dest_path: { type: "string", description: "Destination path for copy_files" },
      base: { type: "string", description: "Base branch/commit for compare" },
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
      const repoInput = String(args.repo ?? "")
      const action = String(args.action ?? "")
      const parsed = parseRepo(repoInput)
      if (!parsed)
        return textResult(`github: invalid repo format "${repoInput}". Use owner/repo or full GitHub URL.`, true)
      const { owner, repo } = parsed
      switch (action) {
        case "get_tree":
          return textResult(await githubGetTree(owner, repo, ghToken))
        case "read_files": {
          const paths = String(args.path ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
          if (paths.length === 0) return textResult("github: path is required for read_files.", true)
          return textResult(await githubReadFiles(owner, repo, paths, ghToken))
        }
        case "copy_files": {
          const source = String(args.source_path ?? "")
          const dest = String(args.dest_path ?? "")
          if (!source || !dest)
            return textResult("github: source_path and dest_path are required for copy_files.", true)
          return textResult(await githubCopyFiles(owner, repo, source, dest))
        }
        case "compare": {
          const base = String(args.base ?? "main")
          const head = String(args.head ?? "HEAD")
          return textResult(await githubCompare(owner, repo, base, head, ghToken))
        }
        default:
          return textResult(
            `github: unknown action "${action}". Use get_tree, read_files, copy_files, or compare.`,
            true,
          )
      }
    },
  }
}

export { parseRepo }
