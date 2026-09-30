/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"

/** Well-known project manifest file names, in detection order. */
const MANIFESTS: Array<{ file: string; project: string }> = [
  { file: "package.json", project: "Node" },
  { file: "pyproject.toml", project: "Python (pyproject)" },
  { file: "requirements.txt", project: "Python (requirements)" },
  { file: "Cargo.toml", project: "Rust" },
  { file: "go.mod", project: "Go" },
  { file: "pom.xml", project: "Java/Maven" },
  { file: "build.gradle", project: "Java/Gradle" },
  { file: "Gemfile", project: "Ruby" },
  { file: "composer.json", project: "PHP" },
  { file: "tsconfig.json", project: "TypeScript config" },
]

const definition: ToolDefinition = {
  timeoutMs: 30_000,
  name: "read_manifest",
  description:
    "Detect and summarize the project manifest(s) in a directory: package.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod, pom.xml, build.gradle, Gemfile, composer.json, or tsconfig.json. Returns project name/version plus a compact list of scripts and dependencies so you can plan builds, tests, and install commands.",
  parameters: {
    type: "object",
    required: [],
    properties: {
      path: { type: "string", description: "Directory to inspect. Default: project root." },
      depth: { type: "integer", description: "How many levels deep to look for nested manifests. Default 1." },
    },
  },
}

export function createReadManifestTool(): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context) {
      const ctx = context as ToolContext
      const base = path.resolve(ctx.cwd, typeof args.path === "string" ? args.path : ".")
      const depth = typeof args.depth === "number" ? Math.max(0, Math.floor(args.depth)) : 1
      const found: Array<{ file: string; summary: string[] }> = []

      const inspect = (dir: string, level: number): void => {
        if (level > depth) return
        for (const m of MANIFESTS) {
          const full = path.join(dir, m.file)
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue
          const summary = summarizeManifest(full, m.file, m.project)
          if (summary.length > 0) found.push({ file: path.relative(base, full) || m.file, summary })
          break // first manifest found in this folder is enough
        }
        if (level < depth) {
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
              inspect(path.join(dir, e.name), level + 1)
            }
          }
        }
      }
      inspect(base, 0)

      if (found.length === 0) {
        return textResult(`No supported manifest found under ${base}`)
      }

      const out = found.map((f) => `Manifest: ${f.file}\n${f.summary.map((s) => `  ${s}`).join("\n")}`).join("\n\n")
      return textResult(out)
    },
  }
}

function summarizeManifest(file: string, kind: string, project: string): string[] {
  const raw = fs.readFileSync(file, "utf8")
  switch (kind) {
    case "package.json":
      return summarizePackageJson(raw)
    case "pyproject.toml":
      return summarizePyproject(raw)
    case "requirements.txt":
      return summarizeRequirements(raw)
    case "Cargo.toml":
      return summarizeCargo(raw)
    case "go.mod":
      return summarizeGoMod(raw)
    case "tsconfig.json":
      return summarizeTsconfig(raw)
    default:
      return summarizeGeneric(raw, `${project} (${kind})`)
  }
}
function summarizePackageJson(raw: string): string[] {
  let json: Record<string, unknown>
  try {
    // tsconfig.json is JSONC in practice (comments + trailing commas);
    // plain JSON.parse marked nearly every real config "unparseable".
    json = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>
  } catch {
    return summarizeGeneric(raw, "package.json (unparseable)")
  }
  const out: string[] = []
  if (typeof json.name === "string") out.push(`name: ${json.name}`)
  if (typeof json.version === "string") out.push(`version: ${json.version}`)
  if (typeof json.type === "string") out.push(`type: ${json.type}`)
  if (typeof json.description === "string") out.push(`description: ${json.description}`)
  const scripts = json.scripts as Record<string, unknown> | undefined
  if (scripts) out.push(`scripts: ${Object.keys(scripts).join(", ")}`)
  for (const [label, key] of [
    ["dependencies", "dependencies"],
    ["devDependencies", "devDependencies"],
  ] as const) {
    const deps = json[key] as Record<string, unknown> | undefined
    if (deps && Object.keys(deps).length > 0) {
      const names = Object.keys(deps)
      out.push(`${label} (${names.length}): ${names.slice(0, 15).join(", ")}${names.length > 15 ? "…" : ""}`)
    }
  }
  if (out.length === 0) out.push("no name/version/scripts found")
  return out
}

function summarizePyproject(raw: string): string[] {
  const out: string[] = []
  const nameRe = /^name\s*=\s*["']?([^"'\n]+)["']?/m
  const versionRe = /^version\s*=\s*["']?([^"'\n]+)["']?/m
  // Prefer [project]; fall back to a whole-file scan so tool.poetry-style
  // files (no [project] table) still report their name/version.
  const name = field(raw, nameRe, "project") ?? field(raw, nameRe)
  const version = field(raw, versionRe, "project") ?? field(raw, versionRe)
  if (name) out.push(`name: ${name}`)
  if (version) out.push(`version: ${version}`)
  // PEP 621 keeps these as ARRAY KEYS inside [project]/[build-system] — there
  // is no [project.dependencies] header, which is what sectionLines() seeks,
  // so it never matched a real pyproject.toml.
  const deps = tomlArrayField(raw, "project", "dependencies")
  if (deps.length > 0)
    out.push(`dependencies (${deps.length}): ${deps.slice(0, 12).join(", ")}${deps.length > 12 ? "…" : ""}`)
  const requires = tomlArrayField(raw, "build-system", "requires")
  if (requires.length > 0) out.push(`build requires (${requires.length}): ${requires.slice(0, 6).join(", ")}`)
  if (out.length === 0) out.push("empty/unknown pyproject.toml")
  return out
}

function summarizeRequirements(raw: string): string[] {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("--") && !l.startsWith("-r "))
  return lines.length === 0
    ? ["empty requirements.txt"]
    : [`${lines.length} requirement(s): ${lines.slice(0, 15).join(", ")}${lines.length > 15 ? "…" : ""}`]
}

function summarizeCargo(raw: string): string[] {
  const out: string[] = []
  const name = sectionField(raw, "package", "name")
  const version = sectionField(raw, "package", "version")
  if (name) out.push(`name: ${name}`)
  if (version) out.push(`version: ${version}`)
  const deps = sectionLines(raw, "dependencies")
  if (deps.length > 0)
    out.push(`dependencies (${deps.length}): ${deps.slice(0, 12).join(", ")}${deps.length > 12 ? "…" : ""}`)
  const dev = sectionLines(raw, "dev-dependencies")
  if (dev.length > 0) out.push(`dev-dependencies (${dev.length}): ${dev.slice(0, 6).join(", ")}`)
  if (out.length === 0) out.push("empty/unknown Cargo.toml")
  return out
}
function summarizeGoMod(raw: string): string[] {
  const out: string[] = []
  const module = raw.match(/^module\s+(\S+)/m)
  if (module) out.push(`module: ${module[1]}`)
  const line = raw.match(/^go\s+(\S+)/m)
  if (line) out.push(`go: ${line[1]}`)
  const reqBlock = raw.match(/^require\s*\(([\s\S]*?)\)/m)
  if (reqBlock) {
    const reqs = reqBlock[1]
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
    out.push(`require (${reqs.length}): ${reqs.slice(0, 12).join(", ")}${reqs.length > 12 ? "…" : ""}`)
  }
  if (out.length === 0) out.push("empty go.mod")
  return out
}

function summarizeTsconfig(raw: string): string[] {
  let json: Record<string, unknown>
  try {
    // tsconfig.json is JSONC in practice (comments + trailing commas);
    // plain JSON.parse marked nearly every real config "unparseable".
    json = JSON.parse(stripJsonc(raw.replace(/^\uFEFF/, ""))) as Record<string, unknown>
  } catch {
    return ["unparseable tsconfig.json"]
  }
  const opts = (json.compilerOptions ?? {}) as Record<string, unknown>
  const out: string[] = []
  out.push(`target: ${String(opts.target ?? "unspecified")}`)
  out.push(`module: ${String(opts.module ?? "unspecified")}`)
  if (opts.strict !== undefined) out.push(`strict: ${String(opts.strict)}`)
  if (opts.outDir) out.push(`outDir: ${String(opts.outDir)}`)
  const include = Array.isArray(json.include) ? json.include.join(", ") : ""
  if (include) out.push(`include: ${include}`)
  return out
}

function summarizeGeneric(raw: string, label: string): string[] {
  const head = raw
    .split("\n")
    .slice(0, 15)
    .filter((l) => l.trim())
  return head.length === 0
    ? [`${label}: empty file`]
    : [`${label}:`].concat(head.map((l) => `  ${l.trim().slice(0, 100)}`))
}

/** Value of `key = "value"` from the toml, optionally narrowed to a `[section]`. */
function field(raw: string, re: RegExp, section?: string): string | undefined {
  const scope = section ? findSection(raw, section) : raw
  if (!scope) return undefined
  const m = scope.match(re)
  return m ? m[1].trim() : undefined
}

/** Items of a multi-line `key = ["a", "b"]` array inside a `[section]`.
 *  sectionLines() cannot do this: it seeks a `[section.key]` HEADER, while
 *  PEP 621 keeps `dependencies` as a plain key inside `[project]`. */
function tomlArrayField(raw: string, section: string, key: string): string[] {
  const scope = findSection(raw, section)
  if (!scope) return []
  const m = scope.match(new RegExp(`^${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m"))
  if (!m) return []
  return Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map((x) => x[1])
}

/** Strip `//`/`/* *​/` comments and trailing commas (string-aware) so JSONC
 *  configs like tsconfig.json parse. Inside strings nothing is touched, so
 *  values like `"url": "https://x"` survive intact. */
function stripJsonc(raw: string): string {
  let out = ""
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++
      continue
    }
    if (c === "/" && raw[i + 1] === "*") {
      i += 2
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++
      i++
      continue
    }
    if (c === ",") {
      let j = i + 1
      while (j < raw.length) {
        if (/\s/.test(raw[j])) {
          j++
          continue
        }
        if (raw[j] === "/" && raw[j + 1] === "/") {
          while (j < raw.length && raw[j] !== "\n") j++
          continue
        }
        if (raw[j] === "/" && raw[j + 1] === "*") {
          j += 2
          while (j < raw.length && !(raw[j] === "*" && raw[j + 1] === "/")) j++
          j++
          continue
        }
        break
      }
      if (raw[j] === "]" || raw[j] === "}") continue // drop trailing comma
      out += c
      continue
    }
    out += c
  }
  return out
}

function sectionField(raw: string, section: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*=\\s*["']?([^"'\n]+)["']?`, "m")
  return field(raw, re, section)
}

function sectionLines(raw: string, section: string): string[] {
  const scope = findSection(raw, section)
  if (!scope) return []
  return scope
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l !== "]" && !l.startsWith("[") && !l.startsWith("#"))
    .map((l) => {
      const eq = l.split(/\s*=\s*/, 1)[0].trim()
      return eq.startsWith('"') || eq.startsWith("'") || eq.includes("==")
        ? l.split(/\s+/)[0].replace(/^["']|["']$/g, "")
        : l.replace(/^["']|["']$/g, "")
    })
    .filter(Boolean)
}

function findSection(raw: string, section: string): string | null {
  const lines = raw.split("\n")
  let inSection = false
  const body: string[] = []
  for (const l of lines) {
    const secMatch = l.match(/^\s*\[([^\]]+)\]/)
    if (secMatch) {
      inSection = secMatch[1] === section
      continue
    }
    if (inSection) {
      if (/^\s*\[/.test(l)) break
      body.push(l)
    }
  }
  return body.join("\n") || null
}
