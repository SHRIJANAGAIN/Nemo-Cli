/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Company library — a whole external agent collection (divisions of `.md`
 * personas, e.g. `agency-agents-main`) mounted as ONE company inside
 * Trayambak: `/company` lists its divisions/agents and `run` launches any
 * of them as a subagent through the normal `trayambak__Agent` path.
 *
 * Root resolution (first existing dir wins; never throws, null when absent):
 *   explicit arg > TRAYAMBAK_COMPANY_DIR > ~/agency-agents-main >
 *   <cwd>/agency-agents-main
 *
 * Division set: `divisions.json` is the source of truth when present (same
 * contract its own CI enforces); otherwise every top-level directory except
 * NON_DIVISION_DIRS counts. Agent scan per division is recursive (depth 3 —
 * game-development nests engine dirs one level down) over `*.md` only.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

export const COMPANY_HOME_DIRNAME = "agency-agents-main"
export const COMPANY_DIR_ENV = "TRAYAMBAK_COMPANY_DIR"
export const COMPANY_ENABLED_ENV = "TRAYAMBAK_COMPANY_ENABLED"
export const COMPANY_DISABLED_ENV = "TRAYAMBAK_COMPANY_DISABLED"
export const COMPANY_MAX_DEPTH = 3

/** Top-level dirs that are NOT divisions (mirrors divisions.json's note). */
export const NON_DIVISION_DIRS = new Set([
  "integrations",
  "strategy",
  "examples",
  "scripts",
  ".github",
  ".git",
  "node_modules",
  "dist",
  "build",
])

export interface CompanyDivision {
  /** Directory name (`engineering`). */
  readonly id: string
  /** Display label (`Engineering`, from divisions.json when present). */
  readonly label: string
}

export interface CompanyAgent {
  /** Persona name from frontmatter (`Code Reviewer`). */
  readonly name: string
  /** File basename without `.md` (`engineering-code-reviewer`) — unique. */
  readonly slug: string
  readonly description: string
  /** Owning top-level division (`engineering`). */
  readonly division: string
  readonly file: string
}

/** First existing company root wins; null when none is present. `homeDir`
 *  is a test seam for `os.homedir()` (which cannot be stubbed). */
export function resolveCompanyRoot(
  explicitRoot?: string,
  cwd: string = process.cwd(),
  homeDir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: Array<string | undefined> = [
    explicitRoot,
    env[COMPANY_DIR_ENV],
    path.join(homeDir, COMPANY_HOME_DIRNAME),
    path.join(cwd, COMPANY_HOME_DIRNAME),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      /* unreadable — keep looking */
    }
  }
  return null
}

function isDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function readDivisionsJson(root: string): Map<string, string> | null {
  try {
    const raw = fs.readFileSync(path.join(root, "divisions.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const divisions = (parsed as { divisions?: unknown }).divisions
    if (typeof divisions !== "object" || divisions === null) return null
    const out = new Map<string, string>()
    for (const [id, entry] of Object.entries(divisions as Record<string, unknown>)) {
      if (typeof entry === "object" && entry !== null) {
        const label = (entry as { label?: unknown }).label
        if (typeof label === "string" && label.trim()) {
          // Only keep divisions that actually exist on disk — a stale
          // divisions.json must never invent departments.
          if (isDir(path.join(root, id))) out.set(id, label.trim())
        }
      }
    }
    return out.size > 0 ? out : null
  } catch {
    return null
  }
}

/** Divisions sorted by label; empty when the root is missing. `disabled`
 *  division ids are filtered out (the on/off switches). */
export function listCompanyDivisions(
  root: string | null | undefined,
  disabled: readonly string[] = [],
): CompanyDivision[] {
  if (!root || !isDir(root)) return []
  const off = new Set(disabled.map((d) => d.toLowerCase()))
  const keep = (id: string): boolean => !off.has(id.toLowerCase())
  const fromJson = readDivisionsJson(root)
  if (fromJson) {
    return [...fromJson.entries()]
      .filter(([id]) => keep(id))
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !NON_DIVISION_DIRS.has(e.name) && keep(e.name))
    .map((e) => ({ id: e.name, label: e.name }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

function* walkAgentFiles(dir: string, depth = 0): Generator<string> {
  if (depth > COMPANY_MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || NON_DIVISION_DIRS.has(e.name)) continue
      let st: fs.Stats | null = null
      try {
        st = fs.lstatSync(full)
      } catch {
        continue
      }
      if (!st.isDirectory() || st.isSymbolicLink()) continue // no symlink loops
      yield* walkAgentFiles(full, depth + 1)
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      yield full
    }
  }
}

/** Lenient frontmatter read: `name:`/`description:` win, else the basename
 *  (slug) and first heading/first line fill in — same shape as the
 *  specialist-agents parser, plus the owning division. */
export function parseCompanyAgentFile(file: string, division: string): CompanyAgent | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  const text = raw.replace(/^\uFEFF/, "").trim()
  if (!text) return null
  const slug = path.basename(file, path.extname(file))
  let name = slug
  let description = ""
  if (text.startsWith("---")) {
    const closing = text.indexOf("---", 3)
    if (closing !== -1) {
      for (const line of text.slice(3, closing).split("\n")) {
        const idx = line.indexOf(":")
        if (idx <= 0) continue
        const key = line.slice(0, idx).trim().toLowerCase()
        const value = line.slice(idx + 1).trim()
        if (key === "name" && value) name = value
        else if ((key === "description" || key === "desc") && value && !description) description = value
      }
    }
  }
  if (!description) {
    const heading = text.match(/^#{1,6}\s+(.+)$/m)
    description = (heading?.[1] ?? text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200)
  }
  return { name, slug, description, division, file }
}

/** Agents of one division (or all when omitted), sorted division-then-name.
 *  `disabled` division ids are skipped (the per-department off switches). */
export function listCompanyAgents(
  root: string | null | undefined,
  division?: string,
  disabled: readonly string[] = [],
): CompanyAgent[] {
  if (!root || !isDir(root)) return []
  const off = new Set(disabled.map((d) => d.toLowerCase()))
  const divisions = (division ? [division] : listCompanyDivisions(root).map((d) => d.id)).filter(
    (id) => !off.has(id.toLowerCase()),
  )
  const out: CompanyAgent[] = []
  for (const id of divisions) {
    const dir = path.join(root, id)
    if (!isDir(dir)) continue
    for (const file of walkAgentFiles(dir)) {
      const parsed = parseCompanyAgentFile(file, id)
      if (parsed) out.push(parsed)
    }
  }
  return out.sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name))
}

/** Match by persona name, slug, or `division/slug` — case-insensitive.
 *  Disabled divisions never match. */
export function findCompanyAgent(
  root: string | null | undefined,
  query: string,
  division?: string,
  disabled: readonly string[] = [],
): CompanyAgent | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const agents = listCompanyAgents(root, division, disabled)
  if (agents.length === 0) return undefined
  const slash = q.indexOf("/")
  if (slash > 0) {
    const div = q.slice(0, slash)
    const rest = q.slice(slash + 1)
    const scoped = agents.filter((a) => a.division.toLowerCase() === div)
    const hit =
      scoped.find((a) => a.slug.toLowerCase() === rest) ??
      scoped.find((a) => a.slug.toLowerCase().endsWith(`-${rest}`) || a.slug.toLowerCase().startsWith(`${rest}-`))
    if (hit) return hit
  }
  return (
    agents.find((a) => a.name.toLowerCase() === q) ??
    agents.find((a) => a.slug.toLowerCase() === q) ??
    agents.find((a) => a.slug.toLowerCase().endsWith(`-${q}`) || a.slug.toLowerCase().startsWith(`${q}-`))
  )
}

/** Maximum departments named in the prompt block (roster beyond that is
 *  one `trayambak__AgentCatalog` call away — context budget first). */
export const COMPANY_PROMPT_MAX_DIVISIONS = 40

/**
 * Absolute division directories for discovery wiring
 * (`agentProfileDirs`): company personas become normal subagent profiles
 * with source `company/<division>`. Empty when the root is missing;
 * disabled divisions are left out.
 */
export function companyAgentDirs(root: string | null | undefined, disabled: readonly string[] = []): string[] {
  if (!root || !isDir(root)) return []
  return listCompanyDivisions(root, disabled)
    .map((d) => path.join(root, d.id))
    .filter(isDir)
}

/**
 * System-prompt block so the MODEL knows the company and uses it itself:
 * departments with counts, how to spawn a persona via `trayambak__Agent`,
 * and the user-only slash-command rule. "" when no library is present or
 * the master switch is OFF (the model must not invent employees).
 */
export function buildCompanyBlock(cwd: string, config?: CompanyConfig | null, homeDir: string = os.homedir()): string {
  let state: CompanyState | null = null
  try {
    state = resolveCompanyState(undefined, cwd, homeDir, config ?? null)
  } catch {
    return ""
  }
  if (!state?.enabled) return ""
  let divisions: CompanyDivision[]
  try {
    divisions = listCompanyDivisions(state.root, state.disabled)
  } catch {
    return ""
  }
  if (divisions.length === 0) return ""
  const counts = new Map<string, number>()
  try {
    for (const a of listCompanyAgents(state.root, undefined, state.disabled)) {
      counts.set(a.division, (counts.get(a.division) ?? 0) + 1)
    }
  } catch {
    return ""
  }
  const shown = divisions.slice(0, COMPANY_PROMPT_MAX_DIVISIONS)
  const deptList = shown.map((d) => `${d.id} (${counts.get(d.id) ?? 0})`).join(", ")
  const more = divisions.length > shown.length ? ` +${divisions.length - shown.length} more (see AgentCatalog)` : ""
  const total = [...counts.values()].reduce((n, c) => n + c, 0)
  const modelLine =
    config?.companyModel?.trim() && state
      ? `- Company runs use model \`${config.companyModel.trim()}\` (only company personas; everything else runs the session model).`
      : null
  return [
    `## COMPANY (${total} specialists across ${divisions.length} departments — yours to command, no asking needed)`,
    `- Departments: ${deptList}${more}. Pick by domain; a security audit goes to a security persona, UI work to design, and so on.`,
    `- "tumhari company" / "your company" / "company" from the user ALWAYS means THIS library — answer from the roster here, never the web. (SKT AI LABS the business — website, pricing, docs — is a different thing and still uses the web.)`,
    "- Run one YOURSELF with `trayambak__Agent`: subagent_type = the persona name (e.g. \"Code Reviewer\"), prompt = the task.",
    "- Never tell the user to type /company — slash commands are user-only; you spawn the subagent directly.",
    "- Full roster anytime: `trayambak__AgentCatalog`. Only enabled departments are listed — use exactly the names you see.",
    ...(modelLine ? [modelLine] : []),
  ].join("\n")
}

/** Comma-separated division ids from `TRAYAMBAK_COMPANY_DISABLED`. */
export function companyDisabledFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[COMPANY_DISABLED_ENV]
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Master switch from `TRAYAMBAK_COMPANY_ENABLED`: `0`/`false`/`off`/`no`
 *  (any case) means OFF; unset means default-ON (undefined = no opinion). */
export function companyEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env[COMPANY_ENABLED_ENV]
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === "0" || v === "false" || v === "off" || v === "no") return false
  return true
}

export interface CompanyState {
  readonly root: string
  /** Master switch (default ON). When false, every list/find/dirs call at
   *  the call sites is skipped — the company vanishes from discovery. */
  readonly enabled: boolean
  /** Division ids switched off (effective list: config wins, else env). */
  readonly disabled: string[]
}

/** Config slice this module reads (the full TrayambakConfig satisfies it). */
export interface CompanyConfig {
  readonly companyDir?: string
  readonly companyEnabled?: boolean
  readonly companyDisabled?: string[]
  readonly companyModel?: string
}

/**
 * Model override for a company-employee run: the configured `companyModel`
 * applies ONLY to company personas, and only when it differs from the
 * session model (default = one model does everything, no rebuild churn).
 * Explicit per-task models are resolved before this helper is consulted.
 */
export function companyModelForProfile(
  profileSource: string | undefined,
  config: CompanyConfig | undefined | null,
  sessionModel: string | undefined,
): string | undefined {
  if (!profileSource?.startsWith("company/")) return undefined
  const m = config?.companyModel?.trim()
  if (!m || m === sessionModel) return undefined
  return m
}

/**
 * Resolve root + on/off state in one call. Layer order: explicit root arg
 * first, then `companyDir` config, then the standard root chain; enabled
 * defaults ON unless config/env says otherwise; disabled is the config
 * list when set, else the env list. Null when no library is present.
 */
export function resolveCompanyState(
  explicitRoot?: string,
  cwd: string = process.cwd(),
  homeDir: string = os.homedir(),
  config?: CompanyConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): CompanyState | null {
  const root = resolveCompanyRoot(explicitRoot ?? config?.companyDir, cwd, homeDir, env)
  if (!root) return null
  const envEnabled = companyEnabledFromEnv(env)
  return {
    root,
    enabled: config?.companyEnabled ?? envEnabled ?? true,
    disabled: config?.companyDisabled ?? companyDisabledFromEnv(env),
  }
}
