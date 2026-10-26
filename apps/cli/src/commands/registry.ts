/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { NemoConfig } from "../../../runtime/src/index.js"

export type CommandCategory =
  "Session" | "Configuration" | "Tools & Skills" | "Info" | "Exit" | "Agent" | "Task" | "Plan" | "Worktree"

export interface SlashCommandDef {
  name: string
  description: string
  category: CommandCategory
  aliases?: string[]
  argsHint?: string
  cliOnly?: boolean
  gatewayOnly?: boolean
  busyPolicy?: "dispatch" | "reject" | "interrupt_then_dispatch"
  handler?: (args: string[], config: NemoConfig) => string | Promise<string>
}

export interface SlashCommand extends SlashCommandDef {
  readonly canonical: string
  readonly aliases: string[]
}

export class SlashCommandRegistry {
  private readonly byName = new Map<string, SlashCommand>()
  private readonly aliases = new Map<string, string>()
  private readonly _byCategory = new Map<string, SlashCommand[]>()

  register(def: SlashCommandDef): SlashCommandRegistry {
    const canonical = def.name.trim().replace(/^\//, "").toLowerCase()
    const aliases = new Set((def.aliases ?? []).map((a) => a.trim().replace(/^\//, "").toLowerCase()))
    aliases.add(canonical)

    const command: SlashCommand = {
      ...def,
      canonical,
      aliases: Array.from(aliases),
    }

    for (const alias of aliases) {
      this.byName.set(alias, command)
      this.aliases.set(alias, canonical)
    }

    const category = def.category
    const list = this._byCategory.get(category) ?? []
    list.push(command)
    this._byCategory.set(category, list)

    return this
  }

  resolve(name: string): SlashCommand | undefined {
    const key = name.trim().replace(/^\//, "").toLowerCase()
    return this.byName.get(key)
  }

  resolveAlias(name: string): string {
    const key = name.trim().replace(/^\//, "").toLowerCase()
    return this.aliases.get(key) ?? key
  }

  all(): SlashCommand[] {
    const seen = new Set<string>()
    const result: SlashCommand[] = []
    for (const cmd of this.byName.values()) {
      if (!seen.has(cmd.canonical)) {
        seen.add(cmd.canonical)
        result.push(cmd)
      }
    }
    return result
  }

  byCategory(category: CommandCategory): SlashCommand[] {
    return this._byCategory.get(category) ?? []
  }

  flat(): Record<string, SlashCommand> {
    const out: Record<string, SlashCommand> = {}
    for (const [key, cmd] of this.byName) out[key] = cmd
    return out
  }

  clear(): void {
    this.byName.clear()
    this.aliases.clear()
    this._byCategory.clear()
  }
}

export function createSlashRegistry(): SlashCommandRegistry {
  return new SlashCommandRegistry()
}
