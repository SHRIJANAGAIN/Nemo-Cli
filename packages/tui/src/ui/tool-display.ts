/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { paint, stripAnsi } from "./theme"
import { graphemes } from "../ink-app/utils/stringWidth.js"

/** Collapse tool output to maxLines/maxChars with ellipsis (truncated preview). */
export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split("\n")
  // Grapheme budget: `Array.from` counts code points, so slicing still
  // stranded Devanagari matras from their base at the clip.
  const clusters = graphemes(output)
  if (lines.length <= maxLines && clusters.length <= maxChars) {
    return { output, overflow: false }
  }
  const preview = lines.slice(0, maxLines).join("\n")
  const previewClusters = graphemes(preview)
  if (previewClusters.length > maxChars) {
    return {
      output: previewClusters.slice(0, Math.max(0, maxChars - 1)).join("") + "…",
      overflow: true,
    }
  }
  return { output: [...lines.slice(0, maxLines), "…"].join("\n"), overflow: true }
}

/** Human-friendly display names per tool. */
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  list_dir: "List",
  glob: "Glob",
  grep: "Grep",
  code_search: "Search",
  read_manifest: "Manifest",
  web_fetch: "Fetch",
  todo: "Task",
  memory: "Memory",
  mcp: "MCP",
  skills: "Skills",
}

export function toolDisplayName(name: string): string {
  return TOOL_NAMES[name] ?? name
}

/** Short arg summary for the tool title row. */
export function toolTitleArgs(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string") return args.command
  if ((name === "read_file" || name === "write_file" || name === "edit_file") && typeof args.path === "string")
    return args.path
  if (name === "list_dir" && typeof args.path === "string") return args.path || "."
  if (name === "grep" && typeof args.pattern === "string") return args.pattern
  if (name === "glob" && typeof args.pattern === "string") return args.pattern
  const keys = Object.keys(args ?? {})
  return keys.length > 0 ? keys.join(", ") : ""
}

/** First line + optional error detail for a tool result row. */
export function toolResultPreview(result: string, ok: boolean, maxChars = 160): string {
  const first = result.split("\n").find((l) => l.trim().length > 0) ?? ""
  const flat = first.replace(/\s+/g, " ").trim()
  // Cluster-safe clip: cutting by UTF-16 units stranded a combining mark
  // from its base at the "…" when the tool result carried Hindi text.
  const clipped =
    graphemes(flat).length > maxChars
      ? graphemes(flat)
          .slice(0, Math.max(0, maxChars - 1))
          .join("") + "…"
      : flat
  return ok ? clipped : `${clipped}`
}

/** Token-accurate rough estimate (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(stripAnsi(text).length / 4))
}

/** Format a file change line: path +N -M. */
export function formatFileChange(path: string, added: number, removed: number): string {
  return paint("text", path) + " " + paint("diffAdded", `+${added}`) + " " + paint("diffRemoved", `-${removed}`)
}
