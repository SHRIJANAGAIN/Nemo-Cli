/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { ArtifactManager } from "../../artifacts/index.js"

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "artifact",
  description:
    "Create, update, or list artifacts (deliverable files like HTML, Markdown, code, documents). Artifacts are saved to the artifact store and can be delivered to the user. Use this for any substantial output the user would want to keep or share.",
  parameters: {
    type: "object",
    required: ["action"],
    properties: {
      action: {
        type: "string",
        description: "artifact action",
        enum: ["create", "update", "get", "list", "delete", "search"],
      },
      filename: { type: "string", description: "filename for create/update (e.g. report.html, data.csv)" },
      content: { type: "string", description: "file content for create/update" },
      language: { type: "string", description: "language hint (html, markdown, python, etc.)" },
      id: { type: "string", description: "artifact id for get/update/delete/search" },
      query: { type: "string", description: "search query for search action" },
      metadata: { type: "object", description: "optional metadata key-value pairs" },
    },
  },
}

export function createArtifactTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context: ToolContext) {
      const ctx = context as ToolContext & { artifactManager?: ArtifactManager }
      const manager = ctx.artifactManager ?? new ArtifactManager(ctx.config.cwd)
      const action = String(args.action ?? "")

      try {
        switch (action) {
          case "create": {
            const filename = String(args.filename ?? `artifact_${Date.now()}`)
            const content = String(args.content ?? "")
            const language = String(args.language ?? "text")
            if (!filename || !content)
              return textResult("artifact: filename and content are required for create.", /*isError*/ true)
            const metadata = (args.metadata as Record<string, string> | undefined) ?? {}
            const artifact = manager.create(filename, content, language, metadata)
            return textResult(
              `Created artifact: ${artifact.filename} (id=${artifact.id}, version=${artifact.version}, ${artifact.size} bytes)`,
            )
          }
          case "update": {
            const id = String(args.id ?? "")
            const content = String(args.content ?? "")
            if (!id || !content)
              return textResult("artifact: id and content are required for update.", /*isError*/ true)
            const metadata = (args.metadata as Record<string, string> | undefined) ?? {}
            const updated = manager.update(id, content, metadata)
            if (!updated) return textResult(`artifact: id ${id} not found.`, /*isError*/ true)
            return textResult(`Updated artifact: ${updated.filename} (id=${updated.id}, version=${updated.version})`)
          }
          case "get": {
            const id = String(args.id ?? "")
            if (!id) return textResult("artifact: id is required for get.", /*isError*/ true)
            const artifact = manager.get(id)
            if (!artifact) return textResult(`artifact: id ${id} not found.`, /*isError*/ true)
            return textResult(
              `Artifact: ${artifact.filename} (id=${artifact.id}, version=${artifact.version}, language=${artifact.language})\n${artifact.content}`,
            )
          }
          case "list": {
            const artifacts = manager.list()
            if (artifacts.length === 0) return textResult("No artifacts found.")
            const lines = artifacts.map(
              (a) =>
                `- ${a.filename} (id=${a.id}, v${a.version}, ${a.language}, ${a.size} bytes, updated=${new Date(a.updatedAt).toISOString()})`,
            )
            return textResult(`Artifacts (${artifacts.length}):\n${lines.join("\n")}`)
          }
          case "delete": {
            const id = String(args.id ?? "")
            if (!id) return textResult("artifact: id is required for delete.", /*isError*/ true)
            const deleted = manager.delete(id)
            return textResult(deleted ? `Deleted artifact ${id}.` : `artifact: id ${id} not found.`)
          }
          case "search": {
            const query = String(args.query ?? "")
            if (!query) return textResult("artifact: query is required for search.", /*isError*/ true)
            const results = manager.search(query)
            if (results.length === 0) return textResult(`No artifacts matching "${query}".`)
            const lines = results.map((a) => `- ${a.filename} (id=${a.id}, v${a.version}, ${a.language})`)
            return textResult(`Search results for "${query}" (${results.length}):\n${lines.join("\n")}`)
          }
          default:
            return textResult(
              `artifact: unknown action "${action}". Use create, update, get, list, delete, or search.`,
              /*isError*/ true,
            )
        }
      } catch (err) {
        return textResult(`artifact error: ${err instanceof Error ? err.message : String(err)}`, /*isError*/ true)
      }
    },
  }
}
