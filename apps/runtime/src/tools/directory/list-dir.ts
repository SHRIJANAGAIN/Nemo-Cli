/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import {
  textResult,
  type Tool,
  type ToolContext,
  resolveConstrainedPath,
  assertExternalDirectory,
  accessDeniedMessage,
} from "../types.js"

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
            accessDeniedMessage(error),
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
