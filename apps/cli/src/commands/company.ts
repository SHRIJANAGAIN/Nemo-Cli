/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as os from "os"
import { loadConfig, saveConfig } from "../../../runtime/src/index.js"
import {
  COMPANY_DIR_ENV,
  COMPANY_HOME_DIRNAME,
  findCompanyAgent,
  listCompanyAgents,
  listCompanyDivisions,
  resolveCompanyRoot,
  resolveCompanyState,
} from "../../../runtime/src/agent/company-library.js"

export interface CompanyOptions {
  readonly action: "divisions" | "list" | "info" | "run" | "on" | "off" | "enable" | "disable" | "status"
  readonly division?: string
  readonly type?: string
  readonly prompt?: string
  readonly root?: string
  /** Test seam for the home-directory fallback (mirrors resolveCompanyRoot). */
  readonly homeDir?: string
}

function missingRoot(explicit?: string): string {
  const tried = [
    explicit,
    process.env[COMPANY_DIR_ENV] ? `${COMPANY_DIR_ENV}=${process.env[COMPANY_DIR_ENV]}` : undefined,
    `~/${COMPANY_HOME_DIRNAME}`,
    `./${COMPANY_HOME_DIRNAME}`,
  ].filter(Boolean)
  return (
    `Company library not found (looked in: ${tried.join(", ")}). ` +
    `Point ${COMPANY_DIR_ENV} at the checkout or set "companyDir" in config.`
  )
}

/**
 * Split `<agent.../> <prompt.../>` tail words: company persona names have
 * spaces, so the longest leading run that names a roster agent wins
 * (`run Code Reviewer audit x` → agent "Code Reviewer", prompt "audit x").
 * Disabled divisions are out of the roster. Shared by the registry path
 * and the TUI so both split identically.
 */
export function splitCompanyRunArgs(
  root: string,
  words: readonly string[],
  disabled: readonly string[] = [],
): { type: string; prompt: string } | null {
  const roster = listCompanyAgents(root, undefined, disabled)
  const match = (q: string): string | undefined => {
    const query = q.toLowerCase()
    return (
      roster.find((a) => a.name.toLowerCase() === query)?.name ??
      roster.find((a) => a.slug.toLowerCase() === query)?.name
    )
  }
  for (let k = Math.min(words.length - 1, 5); k >= 1; k--) {
    const type = match(words.slice(0, k).join(" "))
    if (type) {
      const prompt = words.slice(k).join(" ").trim()
      if (prompt) return { type, prompt }
      return null
    }
  }
  return null
}

function isKnownDivision(root: string, id: string): boolean {
  return listCompanyDivisions(root).some((d) => d.id.toLowerCase() === id.toLowerCase())
}

export { isKnownDivision }

function setMaster(on: boolean): string {
  saveConfig({ companyEnabled: on })
  return on
    ? "Company ON — all enabled departments list and run again."
    : "Company OFF — departments stay listed for browsing, but no company agent lists or runs (discovery skips the library)."
}

function setDivision(root: string, id: string, enable: boolean): string {
  if (!isKnownDivision(root, id)) {
    const ids = listCompanyDivisions(root).map((d) => d.id).join(", ")
    return `Unknown division: ${id} (divisions: ${ids})`
  }
  const key = listCompanyDivisions(root).find((d) => d.id.toLowerCase() === id.toLowerCase())?.id ?? id
  const current = loadConfig().companyDisabled ?? []
  const next = enable ? current.filter((d) => d.toLowerCase() !== key.toLowerCase()) : [...current, key]
  saveConfig({ companyDisabled: [...new Set(next)] })
  return enable ? `${key} enabled.` : `${key} disabled — its agents no longer list or run.`
}

export function companyCommand(options: CompanyOptions): string {
  if (options.action === "on") return setMaster(/*enabled*/ true)
  if (options.action === "off") return setMaster(/*enabled*/ false)
  const homeDir = options.homeDir ?? os.homedir()
  const root = resolveCompanyRoot(options.root, process.cwd(), homeDir)
  if (!root) return missingRoot(options.root)
  if (options.action === "enable" || options.action === "disable") {
    if (!options.division && !options.type) return `Usage: /company ${options.action} <division>`
    return setDivision(root, options.division ?? options.type ?? "", options.action === "enable")
  }
  const state = resolveCompanyState(options.root, process.cwd(), homeDir, loadConfig())
  if (state && !state.enabled && (options.action === "list" || options.action === "info" || options.action === "run")) {
    return "Company is OFF — `/company on` to enable it."
  }
  const disabled = state?.disabled ?? []
  switch (options.action) {
    case "divisions": {
      const divisions = listCompanyDivisions(root)
      if (divisions.length === 0) return `Company library at ${root} has no divisions.`
      const off = new Set(disabled.map((d) => d.toLowerCase()))
      const agents = listCompanyAgents(root, undefined, disabled)
      const counts = new Map<string, number>()
      for (const a of agents) counts.set(a.division, (counts.get(a.division) ?? 0) + 1)
      const lines = divisions.map((d) =>
        off.has(d.id.toLowerCase())
          ? `- ${d.id} — ${d.label} (OFF)`
          : `- ${d.id} — ${d.label} (${counts.get(d.id) ?? 0} agents)`,
      )
      return (
        `Company divisions (${divisions.length} departments, ${agents.length} agents${state && !state.enabled ? ", master OFF" : ""}) [${root}]:\n` +
        lines.join("\n") +
        `\n/company list [division] · /company info <agent> · /company run <agent> <prompt> · /company off|on · /company disable|enable <division>`
      )
    }
    case "list": {
      if (options.division) {
        const agents = listCompanyAgents(root, options.division, disabled)
        if (agents.length === 0) {
          const ids = listCompanyDivisions(root).map((d) => d.id).join(", ")
          return `Unknown, empty, or disabled division: ${options.division} (divisions: ${ids})`
        }
        return (
          `Company agents in ${options.division} (${agents.length}):\n` +
          agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")
        )
      }
      const divisions = listCompanyDivisions(root, disabled)
      const agents = listCompanyAgents(root, undefined, disabled)
      if (agents.length === 0) return `Company library at ${root} has no enabled agents.`
      const byDivision = new Map<string, typeof agents>()
      for (const a of agents) {
        const list = byDivision.get(a.division) ?? []
        list.push(a)
        byDivision.set(a.division, list)
      }
      const label = new Map(divisions.map((d) => [d.id, d.label]))
      const blocks = [...byDivision.entries()].map(
        ([id, list]) =>
          `## ${label.get(id) ?? id} (${list.length})\n` + list.map((a) => `- ${a.name}: ${a.description}`).join("\n"),
      )
      return `Company agents (${agents.length} across ${byDivision.size} departments):\n` + blocks.join("\n")
    }
    case "info": {
      if (!options.type) return "Usage: /company info <agent>"
      const agent = findCompanyAgent(root, options.type, options.division, disabled)
      if (!agent) return `Company agent not found: ${options.type}`
      return (
        `Company agent: ${agent.name}\nDivision: ${agent.division}\nDescription: ${agent.description}\nFile: ${agent.file}`
      )
    }
    case "run": {
      if (!options.type?.trim() || !options.prompt?.trim()) return "Usage: /company run <agent|division|all> <prompt>"
      const t = options.type.trim()
      // Mass launch: a whole department or the entire enabled roster —
      // one item per agent; the TUI runs them in bounded batches.
      if (t.toLowerCase() === "all" || isKnownDivision(root, t)) {
        const agents = t.toLowerCase() === "all" ? listCompanyAgents(root, undefined, disabled) : listCompanyAgents(root, t, disabled)
        if (agents.length === 0) return `No enabled agents in: ${t}`
        const scope = t.toLowerCase() === "all" ? [...new Set(agents.map((a) => a.division))].join(", ") : t
        const prompt = options.prompt.trim()
        return `[Company queued] ${agents.length} agents (${scope}) will execute: ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`
      }
      const agent = findCompanyAgent(root, t, options.division, disabled)
      if (!agent) return `Company agent not found: ${t}`
      return `[Company queued] ${agent.name} [${agent.division}] will execute: ${options.prompt.slice(0, 200)}${options.prompt.length > 200 ? "..." : ""}`
    }
    case "status": {
      const off = disabled.length > 0 ? disabled.join(", ") : "none"
      const onOff = state?.enabled === false ? "OFF" : "ON"
      const model = loadConfig().companyModel
      return `Company: ${onOff} · disabled departments: ${off} · model: ${model ?? "session default (one model for everything)"} · root: ${root}`
    }
    default:
      return `Unknown company action: ${options.action}`
  }
}
