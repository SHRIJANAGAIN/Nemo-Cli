/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
      name: "task",
      description: "List and manage trayambak tasks",
      category: "Task",
      aliases: ["t"],
      argsHint: "[list|create|update|get|output|reset]",
      handler: async (args: string[]) => {
        const { taskCommand } = await import("./task.js")
        const action = (args[0] ?? "list") as "list" | "create" | "update" | "get" | "output" | "reset"
        if (action === "create") {
          return taskCommand({ action, content: args.slice(1).join(" "), id: args[1] })
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
          return planCommand({ action, name: args[1], description: args[2] })
        }
        if (action === "add-step") {
          return planCommand({ action, planId: args[1], stepDescription: args.slice(2).join(" ") })
        }
        if (action === "update-step") {
          const status = args[3] as "pending" | "in_progress" | "completed" | "blocked" | undefined
          return planCommand({ action, planId: args[1], stepId: args[2], status, stepDescription: args[3] })
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
      handler: async () => {
        const { compactCommand } = await import("./compact.js")
        return compactCommand({ action: "config" })
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
      handler: async () => {
        const { modeCommand } = await import("./mode.js")
        return modeCommand({ action: "list" })
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
      handler: async () => {
        const { worktreeCommand } = await import("./worktree.js")
        return worktreeCommand({ action: "list" })
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
