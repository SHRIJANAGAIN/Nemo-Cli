/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type { TrayambakConfig } from "../../../runtime/src/index.js"
import { SlashCommandRegistry, type SlashCommandDef, type CommandCategory } from "./registry.js"

export interface CommandDispatchResult {
  readonly matched: boolean
  readonly command?: string
  readonly output: string
}

function makeDef(def: Omit<SlashCommandDef, "handler"> & { handler: SlashCommandDef["handler"] }): SlashCommandDef {
  return def as SlashCommandDef
}

export function buildTrayambakSlashRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry()

  registry.register(
    makeDef({
      name: "agent",
      description: "List, inspect, or launch trayambak agent profiles",
      category: "Agent",
      aliases: ["a"],
      argsHint: "[list|info|run] [type] [prompt]",
      handler: async (args: string[]) => {
        const { agentCommand } = await import("./agent.js")
        const action = (args[0] ?? "list") as "list" | "info" | "run"
        return agentCommand({ action, type: args[1], prompt: args.slice(2).join(" ") })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "company",
      description: "Browse the company agent library, divide a task across employees, or queue runs",
      category: "Agent",
      argsHint: "[divisions|list|info|run|assign|on|off|enable|disable|status] [division] [agent] [prompt|task]",
      handler: async (args: string[], config) => {
        const { companyCommand } = await import("./company.js")
        const action = (args[0] ?? "divisions") as
          "divisions" | "list" | "info" | "run" | "on" | "off" | "enable" | "disable" | "status"
        if (action === "list") return companyCommand({ action, division: args[1] })
        if (action === "info") return companyCommand({ action, division: undefined, type: args.slice(1).join(" ") })
        if (action === "on" || action === "off" || action === "status") return companyCommand({ action })
        if (action === "enable" || action === "disable") {
          return companyCommand({ action, division: args[1], type: args.slice(1).join(" ") })
        }
        if (action === "run") {
          // "all" / division shortcut first (single token, no name-split
          // needed); otherwise multi-word persona names split by longest
          // leading run that names a roster agent (same split as the TUI).
          const { listCompanyDivisions, resolveCompanyState } =
            await import("../../../runtime/src/agent/company-library.js")
          const runState = resolveCompanyState(undefined, config?.cwd ?? process.cwd(), undefined, config ?? null)
          if (!runState) return companyCommand({ action, type: args[1], prompt: args.slice(2).join(" ") })
          if (!runState.enabled) return "Company is OFF — `/company on` to enable it."
          const tail = args.slice(1)
          const first = (tail[0] ?? "").toLowerCase()
          const divisions = listCompanyDivisions(runState.root, runState.disabled)
          if (first === "all" || (first && divisions.some((d) => d.id.toLowerCase() === first))) {
            return companyCommand({ action, type: tail[0], prompt: tail.slice(1).join(" ") })
          }
          const { splitCompanyRunArgs } = await import("./company.js")
          const split = splitCompanyRunArgs(runState.root, args.slice(1), runState.disabled)
          if (!split) {
            return args.length > 1
              ? `Company agent not found: ${args.slice(1).join(" ")}`
              : "Usage: /company run <agent> <prompt>"
          }
          return companyCommand({ action, type: split.type, prompt: split.prompt })
        }
        // assign/divide — or any unknown first word — treats the line as one
        // task; company formation divides it across employees (company-assign).
        const verb = args[0] ?? ""
        if (verb === "assign" || verb === "divide" || !["divisions", "", "list", "info", "run"].includes(verb)) {
          const { listCompanyAgents, listCompanyDivisions, resolveCompanyState } =
            await import("../../../runtime/src/agent/company-library.js")
          // State-aware: master OFF refuses, disabled departments are left
          // out of the roster the work is divided across.
          const state = resolveCompanyState(undefined, config?.cwd ?? process.cwd(), undefined, config ?? null)
          // Missing library: same help companyCommand prints for bare /company.
          if (!state) return companyCommand({ action: "divisions" })
          if (!state.enabled) return "Company is OFF — `/company on` to enable it."
          const { assignCompanyWork } = await import("./company-assign.js")
          const start = verb === "assign" || verb === "divide" ? 1 : 0
          const parts = args.slice(start)
          // `--run` is TUI-only (this path has no launcher) — strip it and say so.
          const fanout = parts[0] === "--run"
          const task = (fanout ? parts.slice(1) : parts).join(" ")
          const message = assignCompanyWork(
            task,
            listCompanyAgents(state.root, undefined, state.disabled),
            listCompanyDivisions(state.root, state.disabled),
          )
          return fanout
            ? `${message}\nNote: fan-out execution runs in the TUI — /company assign --run <task>.`
            : message
        }
        return companyCommand({ action: "divisions" })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "task",
      description: "List and manage trayambak tasks",
      category: "Task",
      aliases: ["t"],
      argsHint: "[list|create|update|get|output|reset]",
      handler: async (args: string[]) => {
        const { taskCommand } = await import("./task.js")
        const action = (args[0] ?? "list") as "list" | "create" | "update" | "get" | "output" | "reset"
        if (action === "create") {
          // Content is the REST of the line (id=args[1] used to eat the
          // first word from the CLI path; neither path ever passed status).
          return taskCommand({ action, content: args.slice(1).join(" ") })
        }
        if (action === "update") {
          return taskCommand({
            action,
            id: args[1],
            status: args[2] as "pending" | "in_progress" | "completed" | undefined,
          })
        }
        return taskCommand({ action, id: args[1] })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "todo",
      description: "Manage the session-scoped todo list",
      category: "Task",
      aliases: ["td"],
      argsHint: "[list|add|update|clear]",
      handler: async (args: string[]) => {
        const { todoCommand } = await import("./todo.js")
        const action = (args[0] ?? "list") as "list" | "add" | "update" | "clear" | "read"
        if (action === "add") {
          return todoCommand({ action, content: args.slice(1).join(" ") })
        }
        if (action === "update") {
          const id = parseInt(args[1] ?? "", 10)
          const status = args[2] as "pending" | "in_progress" | "completed" | undefined
          return todoCommand({ action: "update", id, status })
        }
        return todoCommand({ action })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "plan",
      description: "Create and manage multi-step plans",
      category: "Plan",
      aliases: ["p"],
      argsHint: "[create|add-step|update-step|complete|list|show]",
      handler: async (args: string[]) => {
        const { planCommand } = await import("./plan.js")
        const action = (args[0] ?? "list") as "create" | "add-step" | "update-step" | "complete" | "list" | "show"
        if (action === "create") {
          // Description is the REST of the line — args[2] alone dropped every
          // word after the third ("/plan create p do the thing" → "do").
          return planCommand({ action, name: args[1], description: args.slice(2).join(" ") })
        }
        if (action === "add-step") {
          return planCommand({ action, planId: args[1], stepDescription: args.slice(2).join(" ") })
        }
        if (action === "update-step") {
          // <planId> <stepId> <status> [description...]. status and the
          // description used to BOTH read args[3], so the status word
          // overwrote the step description and everything after it vanished.
          const status = args[3] as "pending" | "in_progress" | "completed" | "blocked" | undefined
          return planCommand({
            action,
            planId: args[1],
            stepId: args[2],
            status,
            stepDescription: args.length > 4 ? args.slice(4).join(" ") : undefined,
          })
        }
        if (action === "complete") {
          return planCommand({ action, planId: args[1] })
        }
        if (action === "show") {
          return planCommand({ action, planId: args[1] })
        }
        return planCommand({ action })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "manager",
      description: "Show trayambak manager status and summaries",
      category: "Agent",
      aliases: ["m", "status"],
      argsHint: "[status|agents|tasks|plans|todos|summary]",
      handler: async (args: string[]) => {
        const { managerCommand } = await import("./manager.js")
        const action = (args[0] ?? "status") as "status" | "agents" | "tasks" | "plans" | "todos" | "summary"
        return managerCommand({ action })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "compact",
      description: "Configure and run session compaction",
      category: "Session",
      aliases: ["c"],
      argsHint: "[config|estimate|run|reset]",
      handler: async (args: string[]) => {
        const { compactCommand } = await import("./compact.js")
        // Forward the action the argsHint promises — the old handler
        // hard-coded `config`, so `/compact run` quietly showed settings.
        const action = (args[0] ?? "config") as "config" | "estimate" | "run" | "reset"
        return compactCommand({ action })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "mode",
      description: "List or switch trayambak operating modes",
      category: "Configuration",
      aliases: ["md"],
      argsHint: "[list|current|set] [mode]",
      handler: async (args: string[]) => {
        const { modeCommand } = await import("./mode.js")
        // Forward action + mode name (was hard-coded to `list`, so
        // `/mode set code` listed modes instead of switching).
        const action = (args[0] ?? "list") as "list" | "current" | "set"
        return modeCommand({
          action,
          mode: args[1] as "default" | "plan" | "architect" | "code" | "debug" | "review" | undefined,
        })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "worktree",
      description: "List, create, remove, or switch git worktrees",
      category: "Worktree",
      aliases: ["wt"],
      argsHint: "[list|create|remove|switch] [path|name]",
      handler: async (args: string[]) => {
        const { worktreeCommand } = await import("./worktree.js")
        // Mirror the CLI mapping (was hard-coded to `list`, silently
        // dropping create/remove/switch). create/remove now go through
        // argv git, so user-supplied paths never reach a shell.
        const action = (args[0] ?? "list") as "list" | "create" | "remove" | "switch"
        return worktreeCommand({ action, path: args[1], branch: args[2], name: args[1] })
      },
    }),
  )

  registry.register(
    makeDef({
      name: "client",
      description: "Start or query the trayambak local HTTP client",
      category: "Tools & Skills",
      argsHint: "<health|run <prompt>>",
      handler: async (args: string[]) => {
        const { TrayambakClient } = await import("../../../../packages/client/src/index.js")
        const client = new TrayambakClient()
        if (args[0] === "health" || !args[0]) {
          const status = await client.health()
          return `Client connected: ${status.status} (model: ${status.model})`
        }
        if (args[0] === "run") {
          const prompt = args.slice(1).join(" ")
          if (!prompt) return "Usage: /client run <prompt>"
          const events: unknown[] = []
          await client.run(prompt, (e) => events.push(e))
          return `Client run complete. ${events.length} events received.`
        }
        return `Unknown client subcommand: ${args[0]}`
      },
    }),
  )

  registry.register(
    makeDef({
      name: "sdk",
      description: "Start a thread via the trayambak TypeScript SDK",
      category: "Tools & Skills",
      argsHint: "<prompt>",
      handler: async (args: string[]) => {
        const { TrayambakClient } = await import("../../../../packages/sdk/src/index.js")
        const client = new TrayambakClient()
        const prompt = args.join(" ")
        if (!prompt) return "Usage: /sdk <prompt>"
        const thread = await client.startThread(prompt)
        return `SDK thread ${thread.id} started. ${thread.events.length} events.`
      },
    }),
  )

  return registry
}

export function formatHelp(registry: SlashCommandRegistry): string {
  const lines: string[] = ["trayambak slash commands:"]
  for (const category of [
    "Session",
    "Configuration",
    "Tools & Skills",
    "Info",
    "Exit",
    "Agent",
    "Task",
    "Plan",
    "Worktree",
  ] as CommandCategory[]) {
    const cmds = registry.byCategory(category)
    if (cmds.length === 0) continue
    lines.push(`\n  ${category}:`)
    for (const cmd of cmds) {
      const aliasStr =
        cmd.aliases.length > 1 ? ` (aliases: ${cmd.aliases.filter((a) => a !== cmd.canonical).join(", ")})` : ""
      lines.push(`    /${cmd.canonical}${cmd.argsHint ? ` ${cmd.argsHint}` : ""} - ${cmd.description}${aliasStr}`)
    }
  }
  return lines.join("\n")
}

export async function dispatchSlashCommandAsync(
  registry: SlashCommandRegistry,
  input: string,
  config: TrayambakConfig,
): Promise<CommandDispatchResult> {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) {
    return { matched: false, output: `Not a slash command: ${trimmed}` }
  }

  const parts = trimmed.split(/\s+/)
  const name = parts[0]
  const rest = parts.slice(1)

  const resolved = registry.resolve(name)
  if (!resolved) {
    return { matched: false, output: `Unknown command: ${name}\n\n${formatHelp(registry)}` }
  }

  if (!resolved.handler) {
    return { matched: true, command: resolved.canonical, output: `Command '${resolved.canonical}' has no handler` }
  }

  try {
    const output = await resolved.handler(rest, config)
    return { matched: true, command: resolved.canonical, output }
  } catch (error) {
    return {
      matched: true,
      command: resolved.canonical,
      output: `Command error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
