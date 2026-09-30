/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext, resolveConstrainedPath, assertExternalDirectory } from "../types.js"

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2))
  return p
}

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "list_dir",
  description:
    "List the entries of a directory. Defaults to the project root. Marks directories with a trailing slash.",
  parameters: {
    type: "object",
    required: [],
    properties: {
      path: { type: "string", description: "Directory to list. Default: project root." },
    },
  },
}

export function createListDirTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      try {
        if (_signal?.aborted) return textResult("aborted", /*isError*/ true)
        const ctx = context as ToolContext
        const rel = typeof args.path === "string" ? args.path : "."
        let target: string
        try {
          target = resolveConstrainedPath(path.resolve(ctx.cwd, expandHome(rel)), ctx.cwd)
        } catch (error) {
          return textResult(
            `Access denied: ${error instanceof Error ? error.message : String(error)}`,
            /*isError*/ true,
          )
        }

        if (!fs.existsSync(target)) return textResult(`Directory not found: ${rel}`, /*isError*/ true)
        assertExternalDirectory(target, ctx.cwd)
        if (!fs.statSync(target).isDirectory()) return textResult(`Not a directory: ${rel}`, /*isError*/ true)
        const entries = fs.readdirSync(target, { withFileTypes: true })
        const lines = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        return textResult(`${rel}\n${lines.join("\n")}`)
      } catch (error) {
        return textResult(`List error: ${error instanceof Error ? error.message : String(error)}`, /*isError*/ true)
      }
    },
  }
}
