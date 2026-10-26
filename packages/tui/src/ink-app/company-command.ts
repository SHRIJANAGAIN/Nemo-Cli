/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * TUI handler for `/company` — the company agent library as one company.
 * Extracted from App.tsx (max-file-size cap): the case there delegates
 * here with an explicit deps object, keeping all company UX in one place.
 *
 * Verbs: bare = departments; `list [division]`; `info <agent>`;
 * `run [--bg] <agent...> <prompt...>` launches via the host's subagent
 * launcher (multi-word persona names match by longest prefix, same split
 * as the registry path); `on`/`off` flips the master switch;
 * `enable`/`disable <division>` toggles one department; `status` reports
 * the switches. Every switch persists to config AND rebuilds the agent
 * (devmode-command pattern), so discovery + subagent runs obey it at once.
 */

import { createAgentConfig } from "./app-bootstrap.js"
import type { NemoConfig } from "../../../../apps/runtime/src/config.js"
import { loadConfig, saveConfig } from "../../../../apps/runtime/src/config.js"
import { splitCompanyRunArgs } from "../../../../apps/cli/src/commands/company.js"
import {
  assignmentsToLaunches,
  formatCompanyWork,
  planCompanyWork,
} from "../../../../apps/cli/src/commands/company-assign.js"
import {
  findCompanyAgent,
  listCompanyAgents,
  listCompanyDivisions,
  resolveCompanyState,
} from "../../../../apps/runtime/src/agent/company-library.js"

export interface CompanySlashDeps {
  readonly args: string
  readonly companyDir?: string
  readonly cwd: string
  /** Test seam for the home-directory fallback. */
  readonly homeDir?: string
  readonly addSystemMessage: (content: string, opts?: { persist?: boolean; ttlMs?: number }) => string
  readonly launchSubagent: (type: string, prompt: string, background: boolean) => void
  /** Batch launcher for mass runs (whole department / whole company). */
  readonly launchMany: (items: Array<{ type: string; prompt: string }>, background: boolean) => void
  /** Live agent config, patched in place so the next turn sees the change. */
  readonly agentConfigRef: { current: NemoConfig | null }
  /** Nulled to force an agent rebuild on the next message. */
  readonly agentRef: { current: unknown }
  /** Config as loaded at boot; used only as the `createAgentConfig` seed. */
  readonly bootConfig: Partial<NemoConfig> | null
}

const USAGE =
  "Usage: /company [departments] | assign [--run] <task> | list [division] | info <agent> | run [--bg] <agent|division|all> <prompt> | on | off | enable <division> | disable <division>"

export function handleCompanySlash(deps: CompanySlashDeps): void {
  const { args, addSystemMessage, launchSubagent, launchMany, agentConfigRef, agentRef, bootConfig } = deps

  /** Persist a config patch AND arm the agent rebuild that makes it live. */
  const syncAgentConfig = (patch: Partial<NemoConfig>): void => {
    saveConfig(patch)
    agentConfigRef.current = { ...(agentConfigRef.current ?? createAgentConfig(bootConfig ?? {})), ...patch }
  }

  const state = resolveCompanyState(deps.companyDir, deps.cwd, deps.homeDir, loadConfig())
  if (!state) {
    addSystemMessage(
      "Company library not found — set NEMO_COMPANY_DIR or companyDir to the checkout (e.g. ~/agency-agents-main).",
    )
    return
  }
  const { root } = state
  const rest = args.trim()
  const verb = (rest.split(/\s+/)[0] ?? "").toLowerCase()
  const tail = rest ? rest.split(/\s+/).slice(1) : []

  if (verb === "on" || verb === "off") {
    const enabled = verb === "on"
    syncAgentConfig({ companyEnabled: enabled })
    agentRef.current = null
    addSystemMessage(
      enabled
        ? "Company ON — all enabled departments list and run again."
        : "Company OFF — departments stay listed for browsing, but no company agent lists or runs (discovery skips the library).",
    )
    return
  }
  if (verb === "enable" || verb === "disable") {
    const query = tail.join(" ").trim()
    if (!query) {
      addSystemMessage(`Usage: /company ${verb} <division>`)
      return
    }
    const match = listCompanyDivisions(root).find(
      (d) => d.id.toLowerCase() === query.toLowerCase() || d.label.toLowerCase() === query.toLowerCase(),
    )
    if (!match) {
      const ids = listCompanyDivisions(root)
        .map((d) => d.id)
        .join(", ")
      addSystemMessage(`Unknown division: ${query} (divisions: ${ids})`)
      return
    }
    const current = loadConfig().companyDisabled ?? []
    const next =
      verb === "enable" ? current.filter((d) => d.toLowerCase() !== match.id.toLowerCase()) : [...current, match.id]
    syncAgentConfig({ companyDisabled: [...new Set(next)] })
    agentRef.current = null
    addSystemMessage(
      verb === "enable" ? `${match.id} enabled.` : `${match.id} disabled — its agents no longer list or run.`,
    )
    return
  }

  if (!rest) {
    const divisions = listCompanyDivisions(root)
    if (divisions.length === 0) {
      addSystemMessage(`Company library at ${root} has no divisions.`)
      return
    }
    const off = new Set(state.disabled.map((d) => d.toLowerCase()))
    const agents = listCompanyAgents(root, undefined, state.disabled)
    const counts = new Map<string, number>()
    for (const a of agents) counts.set(a.division, (counts.get(a.division) ?? 0) + 1)
    addSystemMessage(
      `Company divisions (${divisions.length} departments, ${agents.length} agents${state.enabled ? "" : ", master OFF"}):\n` +
        divisions
          .map((d) =>
            off.has(d.id.toLowerCase())
              ? `- ${d.id} — ${d.label} (OFF)`
              : `- ${d.id} — ${d.label} (${counts.get(d.id) ?? 0})`,
          )
          .join("\n") +
        `\n/company list [division] · /company info <agent> · /company assign [--run] <task> · /company run [--bg] <agent|division|all> <prompt> · /company off|on · /company disable|enable <division>`,
    )
    return
  }
  if (verb === "list") {
    if (!state.enabled) {
      addSystemMessage("Company is OFF — `/company on` to enable it.")
      return
    }
    const division = tail[0]
    const agents = listCompanyAgents(root, division, state.disabled)
    if (division && agents.length === 0) {
      const ids = listCompanyDivisions(root)
        .map((d) => d.id)
        .join(", ")
      addSystemMessage(`Unknown, empty, or disabled division: ${division} (divisions: ${ids})`)
      return
    }
    const byDivision = new Map<string, typeof agents>()
    for (const a of agents) {
      const list = byDivision.get(a.division) ?? []
      list.push(a)
      byDivision.set(a.division, list)
    }
    const blocks = [...byDivision.entries()].map(
      ([id, list]) => `## ${id} (${list.length})\n` + list.map((a) => `- ${a.name}: ${a.description}`).join("\n"),
    )
    addSystemMessage(
      `${division ? `Company agents in ${division}` : "Company agents"} (${agents.length}):\n` + blocks.join("\n"),
    )
    return
  }
  if (verb === "info") {
    if (!state.enabled) {
      addSystemMessage("Company is OFF — `/company on` to enable it.")
      return
    }
    const query = tail.join(" ")
    const agent = query ? findCompanyAgent(root, query, undefined, state.disabled) : undefined
    addSystemMessage(
      agent
        ? `Company agent: ${agent.name}\nDivision: ${agent.division}\nDescription: ${agent.description}\nFile: ${agent.file}`
        : query
          ? `Company agent not found: ${query}`
          : "Usage: /company info <agent>",
    )
    return
  }
  // Company formation divides ONE task across employees; `--run` then fans
  // the assignments out through the same bounded-wave launcher mass runs use.
  if (verb === "assign" || verb === "divide") {
    if (!state.enabled) {
      addSystemMessage("Company is OFF — `/company on` to enable it.")
      return
    }
    let parts = tail
    let fanout = false
    if (parts[0] === "--run") {
      fanout = true
      parts = parts.slice(1)
    }
    const task = parts.join(" ").trim()
    if (!task) {
      addSystemMessage("Usage: /company assign [--run] <task>")
      return
    }
    const roster = listCompanyAgents(root, undefined, state.disabled)
    if (roster.length === 0) {
      addSystemMessage("Company library has no employees to assign.")
      return
    }
    const depts = listCompanyDivisions(root, state.disabled)
    const plan = planCompanyWork(task, roster, depts)
    addSystemMessage(formatCompanyWork(plan, depts.length, roster.length))
    const launches = assignmentsToLaunches(plan)
    if (fanout && launches.length > 0) {
      addSystemMessage(`Launching ${launches.length} employees in bounded foreground batches…`)
      launchMany(launches, /*background*/ false)
    }
    return
  }
  if (verb === "run" || verb === "runbg") {
    if (!state.enabled) {
      addSystemMessage("Company is OFF — `/company on` to enable it.")
      return
    }
    let background = verb === "runbg"
    let restParts = tail
    if (restParts[0] === "--bg") {
      background = true
      restParts = restParts.slice(1)
    }
    // Mass launch: a whole department or the entire enabled roster. Forced
    // foreground in bounded batches — 282 live background loops would OOM
    // (observed heap death before); waves of a few at a time stay safe.
    const first = (restParts[0] ?? "").toLowerCase()
    const isDivision = first && listCompanyDivisions(root, state.disabled).some((d) => d.id.toLowerCase() === first)
    if (first === "all" || isDivision) {
      const agents =
        first === "all"
          ? listCompanyAgents(root, undefined, state.disabled)
          : listCompanyAgents(root, restParts[0], state.disabled)
      const prompt = restParts.slice(1).join(" ").trim()
      if (agents.length === 0 || !prompt) {
        addSystemMessage("Usage: /company run <division|all> <prompt>")
        return
      }
      const scope = first === "all" ? "whole company" : `division ${restParts[0]}`
      addSystemMessage(
        `Launching ${agents.length} company agents (${scope}) in bounded foreground batches: ${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}`,
      )
      launchMany(
        agents.map((a) => ({ type: a.name, prompt })),
        /*background*/ false,
      )
      return
    }
    // Disabled departments are out of the roster the split matches against.
    const split = splitCompanyRunArgs(root, restParts, state.disabled)
    if (!split) {
      addSystemMessage(
        "Usage: /company run [--bg] <agent|division|all> <prompt>  ·  /company (departments)  ·  /company list [division]  ·  /company info <agent>",
      )
      return
    }
    launchSubagent(split.type, split.prompt, background)
    return
  }
  if (verb === "status") {
    const off = state.disabled.length > 0 ? state.disabled.join(", ") : "none"
    const model = loadConfig().companyModel
    addSystemMessage(
      `Company: ${state.enabled ? "ON" : "OFF"} · disabled departments: ${off} · model: ${model ?? "session default (one model for everything)"} · root: ${root}`,
    )
    return
  }
  addSystemMessage(USAGE)
}
