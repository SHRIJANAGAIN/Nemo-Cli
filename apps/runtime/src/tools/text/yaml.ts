/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Tool } from "../types.js"
import { textResult, resolveConstrainedPath } from "../types.js"
import * as fs from "fs"

/**
 * Minimal YAML subset parser (indentation-based scalars, lists, inline
 * maps, quoted/unquoted strings, numbers, booleans, null). Enough for
 * config files, front-matter and the vast majority of project yaml.
 */
export interface YamlNode {
  kind: "map" | "list" | "scalar"
  mapEntries?: Array<{ key: string; value: YamlNode }>
  listItems?: YamlNode[]
  scalar?: string
}

function scalarValue(s: string): string {
  const t = s.trim()
  if (t === "" || t === "null" || t === "~") return ""
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).replace(/\\n/g, "\n")
  }
  if (t.includes("#")) {
    const i = t.indexOf("#")
    if (i === 0) return ""
    return t.slice(0, i).trim()
  }
  return t
}

export function parseYamlComment(text: string, maxDepth = 40): YamlNode {
  const lines = text.split(/\r?\n/)
  let pos = 0
  let guard = 0
  const offerBareMap: Array<{ key: string; value: YamlNode }> = []

  function parseBlock(indent: number): YamlNode {
    if (++guard > 4000) return { kind: "scalar", scalar: "…" }
    const entries: Array<{ key: string; value: YamlNode }> = []
    const items: YamlNode[] = []
    let isList = false
    while (pos < lines.length) {
      const line = lines[pos]
      const trimmed = line.trim()
      if (trimmed === "" || trimmed.startsWith("#")) {
        pos++
        continue
      }
      const ind = line.length - line.replace(/^ +/, "").length
      if (ind < indent) break
      if (ind > indent) break // sub-block handled by recursion below
      pos++
      // list item
      const dash = /^(-\s+)(.*)$/.exec(trimmed)
      if (dash) {
        isList = true
        const rest = dash[2]
        const mapMatch = /^(?:([\w.-]+)\s*:\s*)(.*)$/.exec(rest)
        if (mapMatch) {
          const key = mapMatch[1]
          let value: YamlNode
          if (mapMatch[2].trim() === "") value = parseBlock(ind + 2)
          else value = { kind: "scalar", scalar: scalarValue(mapMatch[2]) }
          items.push({ kind: "map", mapEntries: [{ key, value }] })
        } else {
          items.push({ kind: "scalar", scalar: scalarValue(rest) })
        }
        continue
      }
      // map key
      const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(trimmed)
      if (kv) {
        const key = kv[1]
        let value: YamlNode
        if (kv[2].trim() === "") value = parseBlock(ind + 2)
        else value = { kind: "scalar", scalar: scalarValue(kv[2]) }
        entries.push({ key, value })
        continue
      }
      // top-level scalar (e.g. doc end markers)
      offerBareMap.push({ key: trimmed, value: { kind: "scalar", scalar: "<value>" } })
      continue
    }
    void maxDepth
    void indent
    if (isList && items.length > 0) return { kind: "list", listItems: items }
    return { kind: "map", mapEntries: entries }
  }

  const root = parseBlock(0)
  if (offerBareMap.length && (!root.mapEntries || root.mapEntries.length === 0)) {
    root.mapEntries = offerBareMap
  }
  return root
}

function render(node: YamlNode, depth: number, out: string[]): void {
  const pad = "  ".repeat(depth)
  if (node.kind === "scalar") {
    out.push(node.scalar ?? "")
    return
  }
  if (node.kind === "list") {
    for (const it of node.listItems ?? []) {
      if (it.kind === "map" && it.mapEntries && it.mapEntries.length === 1) {
        const { key: k, value: v } = it.mapEntries[0]
        out.push(`${pad}- ${k}: ${v.kind === "scalar" ? v.scalar : ""}`)
        if (v.kind !== "scalar") render(v, depth + 1, out)
      } else {
        out.push(`${pad}- ${it.kind === "scalar" ? it.scalar : ""}`)
        if (it.kind !== "scalar") render(it, depth + 1, out)
      }
    }
    return
  }
  for (const en of node.mapEntries ?? []) {
    if (en.value.kind === "scalar") out.push(`${pad}${en.key}: ${en.value.scalar ?? ""}`)
    else {
      out.push(`${pad}${en.key}:`)
      render(en.value, depth + 1, out)
    }
  }
}

export function createYamlTool(): Tool {
  return {
    definition: {
      timeoutMs: 30_000,
      name: "yaml",
      description:
        "Read a YAML file and render it as an indented readable structure. Useful for inspecting configs, CI workflows, and deployment manifests.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the YAML file" },
          key: { type: "string", description: "Optional dotted path to a sub-key (e.g. build.steps)" },
        },
        required: ["file"],
      },
    },
    async execute(_id, args) {
      try {
        const p = resolveConstrainedPath(String(args.file), process.cwd())
        const text = fs.readFileSync(p, "utf8")
        const root = parseYamlComment(text)
        const out: string[] = []
        render(root, 0, out)
        let result = out.join("\n") || "(empty)"
        if (typeof args.key === "string" && args.key.length > 0) {
          let node = root
          for (const part of String(args.key).split(".")) {
            node = node.mapEntries?.find((e) => e.key === part)?.value ?? { kind: "scalar", scalar: "(not found)" }
          }
          result = `# ${args.key}\n${(() => {
            const o: string[] = []
            render(node, 0, o)
            return o.join("\n")
          })()}`
        }
        return textResult(result.slice(0, 8000))
      } catch (e) {
        return textResult(`yaml failed: ${e instanceof Error ? e.message : String(e)}`, /*isError*/ true)
      }
    },
  }
}
