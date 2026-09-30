/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Custom tool loader — port of SKT AI LABS Code's `./tools` file scan
 * (opencode/src/tool/registry.ts) to trayambak.
 *
 * Users drop `.ts` / `.js` / `.mjs` files into `.trayambak/tool/` or
 * `.trayambak/tools/` (project cwd, plus the global `~/.trayambak`). Each
 * export shaped like `{ args, description, execute }` becomes an LLM tool:
 *
 *   // .trayambak/tools/hello.ts  → tool name "hello"
 *   export default {
 *     description: "Greet someone",
 *     args: { name: { type: "string", description: "Who to greet" } },
 *     execute: async ({ name }) => `hello ${name}`,
 *   };
 *
 * Named exports are namespaced `<filename>_<exportName>` (SKT AI LABS's rule).
 * A malformed or un-importable file is skipped — it must never poison the
 * rest of the registry (#27451, #27630).
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { pathToFileURL } from "url"
import type { ToolParameters, ToolParameterProperty } from "../../../../../packages/protocol/src/index.js"
import { DEFAULT_TOOLSETS } from "../../../../../packages/protocol/src/toolsets.js"
import type { Arsenal } from "../../../../../packages/core/src/toolsets/arsenal.js"
import type { TrayambakConfig } from "../../config.js"
import { textResult, type Tool, type ToolContext, type ToolResult } from "../types.js"

/** A user-authored tool module export (SKT AI LABS's plugin-tool contract). */
export interface CustomToolExport {
  /** May be present-but-undefined (SKT AI LABS tolerated this via `args: undefined`). */
  args?: unknown
  description?: string
  execute: (args: Record<string, unknown>, context: CustomToolContext) => unknown
}

/** Minimal context handed to user tool code (SKT AI LABS passes directory/worktree). */
export interface CustomToolContext {
  cwd: string
  sessionId?: string
  signal?: AbortSignal
}

export interface LoadCustomToolsOptions {
  cwd: string
  /** Defaults to os.homedir(); tests point this at a temp dir for hermeticity. */
  homeDir?: string
  /** Tool names custom files may not shadow (built-ins win). */
  reserved?: readonly string[]
}

/** OpenAI-compatible providers reject names outside [A-Za-z0-9_-] (max 64). */
const MAX_TOOL_NAME = 64
const PARAM_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"])
const TOOL_EXTENSIONS = /\.(js|mjs|ts)$/

/**
 * Tool-file import that works in every realm this loader runs in:
 *  - Production (CommonJS dist): tsc rewrites a bare `import()` into
 *    `require()`, which cannot load file:// URLs or ESM tool files — so the
 *    import is built in global scope where the compiler cannot see it.
 *  - Vitest: a global-scope import has no dynamic-import callback
 *    ("A dynamic import callback was not specified") — the visible
 *    `import()` below is rewritten by Vite to the runner's callback.
 * process.env.VITEST marks the second realm.
 */
const importImpl: (specifier: string) => Promise<unknown> = process.env.VITEST
  ? (specifier) => import(specifier)
  : (new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>)

/** Import one user tool file via a file:// URL (Windows-safe). Node's
 * MODULE_TYPELESS_PACKAGE_JSON reparse warning — raw stderr that would tear
 * through the TUI frame — is silenced at the TUI spawn: apps/cli run.ts
 * passes --disable-warning=MODULE_TYPELESS_PACKAGE_JSON to the child. */
async function importToolModule(file: string): Promise<Record<string, unknown>> {
  return (await importImpl(pathToFileURL(file).href)) as Record<string, unknown>
}

export function sanitizeToolName(raw: string): string {
  const cleaned = raw.replace(/[^\w-]/g, "_").slice(0, MAX_TOOL_NAME)
  return cleaned.length > 0 ? cleaned : "custom_tool"
}

/** Tool id: the `default` export becomes the filename; named exports are
 * namespaced `<filename>_<exportName>` (SKT AI LABS registry.ts scan rule). */
export function customToolName(filePath: string, exportId: string): string {
  const base = path.basename(filePath, path.extname(filePath))
  return sanitizeToolName(exportId === "default" ? base : `${base}_${exportId}`)
}

/** SKT AI LABS's isPluginTool: the three keys must exist (args may be undefined —
 * #27451), plus run-time sanity on description/execute. */
export function isCustomToolExport(value: unknown): value is CustomToolExport {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return (
    "args" in record &&
    "description" in record &&
    "execute" in record &&
    typeof record.description === "string" &&
    record.description.length > 0 &&
    typeof record.execute === "function"
  )
}

function coerceProperties(value: unknown): Record<string, ToolParameterProperty> {
  const properties: Record<string, ToolParameterProperty> = {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) return properties
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue
    const schema = raw as Record<string, unknown>
    if (typeof schema.type !== "string") continue
    properties[key] = {
      ...schema,
      type: PARAM_TYPES.has(schema.type) ? (schema.type as ToolParameterProperty["type"]) : "string",
      description: typeof schema.description === "string" ? schema.description : "",
    } as ToolParameterProperty
  }
  return properties
}

/** `args` contract (SKT AI LABS's legacyJsonSchema port, plus full-schema passthrough):
 *  - undefined / missing / malformed → empty object schema (#27451: a tool with
 *    `args: undefined` must still load with `{ type:"object", properties:{} }`)
 *  - a full JSON Schema (`{ type:"object", properties:{...} }`) → used as-is
 *  - otherwise a field map `{ field: propertySchema }` → properties with
 *    required = declared keys (SKT AI LABS: `required: Object.keys(properties)`) */
export function normalizeParameters(args: unknown): ToolParameters {
  const empty: ToolParameters = { type: "object", properties: {}, required: [] }
  if (args === undefined || args === null) return empty
  if (typeof args !== "object" || Array.isArray(args)) return empty
  const record = args as Record<string, unknown>
  if (record.type === "object") {
    const properties = coerceProperties(record.properties)
    const required = Array.isArray(record.required)
      ? record.required.filter((key): key is string => typeof key === "string")
      : Object.keys(properties)
    return { type: "object", properties, required }
  }
  const properties = coerceProperties(record)
  return { type: "object", properties, required: Object.keys(properties) }
}

function coerceResult(result: unknown): ToolResult {
  if (typeof result === "string") return textResult(result)
  if (result === undefined || result === null) return textResult("")
  if (typeof result === "object") {
    const record = result as Record<string, unknown>
    // Already ToolResult-shaped? Pass it through.
    if (Array.isArray(record.content)) {
      const content = record.content.filter(
        (item): item is { type: "text"; text: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as { type?: unknown }).type === "text" &&
          typeof (item as { text?: unknown }).text === "string",
      )
      if (content.length > 0) return { content, isError: record.isError === true }
    }
    // SKT AI LABS-style `{ output, title?, metadata? }` payload.
    if (typeof record.output === "string") return textResult(record.output)
    try {
      return textResult(JSON.stringify(result, null, 2))
    } catch {
      return textResult(String(result))
    }
  }
  return textResult(String(result))
}

/** Wrap a user export as a trayambak Tool. Returns undefined when the name
 * would shadow a reserved (built-in) tool — built-ins win. */
export function createCustomTool(
  name: string,
  def: CustomToolExport,
  reserved: ReadonlySet<string> = new Set(),
): Tool | undefined {
  if (reserved.has(name)) return undefined
  const definition = {
    timeoutMs: 30_000,
    name,
    description: def.description as string,
    parameters: normalizeParameters(def.args),
  }
  return {
    definition,
    execute: async (_toolCallId, args, signal, _onUpdate, context?: ToolContext) => {
      try {
        const ctx: CustomToolContext = {
          cwd: context?.cwd ?? process.cwd(),
          sessionId: context?.sessionId,
          signal,
        }
        const result = await def.execute((args ?? {}) as Record<string, unknown>, ctx)
        return coerceResult(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return textResult(`Custom tool "${name}" failed: ${message}`, /*isError*/ true)
      }
    },
  }
}

/** Project `.trayambak` plus the global `~/.trayambak` (SKT AI LABS scans its
 * config directories the same way). */
export function customToolDirs(cwd: string, homeDir: string = os.homedir()): string[] {
  return [path.join(cwd, ".trayambak"), path.join(homeDir, ".trayambak")]
}

/** `{tool,tools}/*.{js,mjs,ts}` inside each directory (SKT AI LABS's glob). */
export function discoverCustomToolFiles(dirs: readonly string[]): string[] {
  const files: string[] = []
  for (const dir of dirs) {
    for (const sub of ["tool", "tools"]) {
      const full = path.join(dir, sub)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(full, { withFileTypes: true })
      } catch {
        continue // dir absent is normal
      }
      for (const entry of entries) {
        if (entry.isDirectory()) continue
        if (!TOOL_EXTENSIONS.test(entry.name)) continue
        files.push(path.join(full, entry.name))
      }
    }
  }
  return files
}

/** Scan the custom tool directories and load every valid export. Individual
 * files are isolated: an import error or a malformed export skips just that
 * file/export. First definition wins on name collisions. */
export async function loadCustomTools(options: LoadCustomToolsOptions): Promise<Tool[]> {
  const dirs = customToolDirs(options.cwd, options.homeDir)
  const files = discoverCustomToolFiles(dirs)
  const reserved = new Set(options.reserved ?? [])
  const tools: Tool[] = []
  const seen = new Set<string>()
  for (const file of files) {
    let mod: Record<string, unknown>
    try {
      // file:// URL + global-scope import so this works on Windows and
      // survives CommonJS downleveling (see nativeImport).
      mod = await importToolModule(file)
    } catch {
      continue // one broken file must not poison the registry
    }
    for (const [exportId, value] of Object.entries(mod)) {
      if (!isCustomToolExport(value)) continue
      const name = customToolName(file, exportId)
      if (seen.has(name)) continue
      const tool = createCustomTool(name, value, reserved)
      if (!tool) continue
      seen.add(name)
      tools.push(tool)
    }
  }
  return tools
}

/** Register the dynamically-named `custom` toolset with the Arsenal and make
 * sure it is part of the active defaults (user configs written before this
 * feature lack it). Users can opt out with `toolsets.disabled: ["custom"]`. */
export function registerCustomToolset(arsenal: Arsenal<Tool>, config: TrayambakConfig, toolNames: string[]): void {
  arsenal.registerToolset({
    name: "custom",
    description: "User-defined tools loaded from .trayambak/{tool,tools}",
    toolNames: [...toolNames],
    checkFn: () => true,
  })
  const defaults = config.toolsets?.defaults?.length ? config.toolsets.defaults : DEFAULT_TOOLSETS
  if (!defaults.includes("custom")) {
    arsenal.setCoreTools([...defaults, "custom"])
  } else {
    arsenal.setCoreTools([...defaults])
  }
}
