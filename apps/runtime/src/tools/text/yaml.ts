/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { Tool, ToolContext } from "../types.js"
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
  if (t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\n/g, "\n")
  }
  if (t.startsWith("'") && t.endsWith("'")) {
    // YAML single quotes do NOT process escape sequences: 'a\nb' is the
    // four-character text a\nb, not a line break.
    return t.slice(1, -1)
  }
  // A '#' starts a comment only at the very start of the value or after
  // whitespace. 'https://host/x#frag' and 'a#b' keep their hashes.
  const hash = t.search(/(?:^|\s)#/)
  if (hash >= 0) return hash === 0 ? "" : t.slice(0, hash).trim()
  return t
}

export function parseYamlComment(text: string, maxDepth = 40): YamlNode {
  const lines = text.split(/\r?\n/)
  let pos = 0
  let guard = 0
  const offerBareMap: Array<{ key: string; value: YamlNode }> = []

  /** Indentation of the next non-blank, non-comment line, or -1 at EOF. */
  const nextNonBlankIndent = (): number => {
    let p = pos
    while (p < lines.length) {
      const l = lines[p]
      const tr = l.trim()
      if (tr === "" || tr.startsWith("#")) {
        p++
        continue
      }
      return l.length - l.replace(/^ +/, "").length
    }
    return -1
  }

  /** Recursive child block anchored at the child's REAL indentation. YAML
   *  allows any indent deeper than the parent; anchoring at parent+2 dropped
   *  whole sub-trees written with 3 or 4 spaces. */
  const childBlock = (parentIndent: number): YamlNode => {
    const ahead = nextNonBlankIndent()
    if (ahead > parentIndent) return parseBlock(ahead)
    return { kind: "map", mapEntries: [] }
  }

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
          if (mapMatch[2].trim() === "") value = childBlock(ind)
          else value = { kind: "scalar", scalar: scalarValue(mapMatch[2]) }
          const item: { kind: "map"; mapEntries: Array<{ key: string; value: YamlNode }> } = {
            kind: "map",
            mapEntries: [{ key, value }],
          }
          items.push(item)
          // Continuation lines inside a list item (`- name: build` followed
          // by deeper `command: ...` / `with:` keys — the GitHub Actions /
          // CI step shape) extend the SAME item instead of being dropped.
          const ahead = nextNonBlankIndent()
          if (ahead > ind) {
            const cont = parseBlock(ahead)
            if (cont.kind === "map" && cont.mapEntries) item.mapEntries.push(...cont.mapEntries)
          }
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
        if (kv[2].trim() === "") value = childBlock(ind)
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
      if (it.kind === "map" && it.mapEntries && it.mapEntries.length > 0) {
        // Multi-key items render inline: `- name: build` with the remaining
        // fields (`command: ...`) indented one level, like the source YAML.
        const [first, ...rest] = it.mapEntries
        out.push(`${pad}- ${first.key}: ${first.value.kind === "scalar" ? first.value.scalar : ""}`)
        if (first.value.kind !== "scalar") render(first.value, depth + 1, out)
        // Remaining fields sit one level deeper than the `- key:` line.
        const itemPad = "  ".repeat(depth + 1)
        for (const r of rest) {
          if (r.value.kind === "scalar") out.push(`${itemPad}${r.key}: ${r.value.scalar ?? ""}`)
          else {
            out.push(`${itemPad}${r.key}:`)
            render(r.value, depth + 2, out)
          }
        }
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
    async execute(_id, args, _signal, _update, context) {
      try {
        // Relative paths must resolve against the tool's own cwd, which can
        // differ from the CLI's process.cwd() (session in a worktree/subdir).
        const cwd = (context as ToolContext | undefined)?.cwd ?? process.cwd()
        const p = resolveConstrainedPath(String(args.file), cwd)
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
