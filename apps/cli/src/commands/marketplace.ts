/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {
  defaultMarketplaceSource,
  installMarketplaceEntry,
  removeMarketplaceEntry,
  scanMarketplace,
  searchMarketplace,
  type MarketplaceKind,
} from "../../../runtime/src/tools/marketplace/marketplace.js"
import { failOutput, usageOutput } from "../command-registry.js"

export interface MarketplaceOptions {
  action?: string
  kind?: string
  nameOrQuery?: string
  source?: string
  cwd?: string
}

function entriesText(entries: Array<{ kind: string; name: string; description: string }>): string {
  if (entries.length === 0) return "Marketplace shelf is empty."
  return entries.map((e) => `  - [${e.kind}] ${e.name}${e.description ? `: ${e.description}` : ""}`).join("\n")
}

/** `nemo marketplace <list|search|install|remove>`: shelf CLI twin. */
export function marketplaceCommand(opts: MarketplaceOptions): string {
  const action = (opts.action ?? "list").trim().toLowerCase()
  const source = opts.source && opts.source.length > 0 ? opts.source : defaultMarketplaceSource()
  const cwd = opts.cwd ?? process.cwd()
  switch (action) {
    case "list":
      return entriesText(scanMarketplace(source))
    case "search": {
      if (!opts.nameOrQuery) return usageOutput("Usage: nemo marketplace search <query> [--source <dir>]")
      const hits = searchMarketplace(source, opts.nameOrQuery)
      return hits.length > 0 ? entriesText(hits) : failOutput(`No marketplace entries match '${opts.nameOrQuery}'.`)
    }
    case "install": {
      const kind = (opts.kind ?? "").trim().toLowerCase()
      if (kind !== "skill" && kind !== "agent")
        return usageOutput("Usage: nemo marketplace install <skill|agent> <name> [--source <dir>]")
      if (!opts.nameOrQuery)
        return usageOutput("Usage: nemo marketplace install <skill|agent> <name> [--source <dir>]")
      const result = installMarketplaceEntry(source, kind as MarketplaceKind, opts.nameOrQuery, cwd)
      return result.ok ? result.message : failOutput(`Error: ${result.error}`)
    }
    case "remove": {
      const kind = (opts.kind ?? "").trim().toLowerCase()
      if (kind !== "skill" && kind !== "agent")
        return usageOutput("Usage: nemo marketplace remove <skill|agent> <name>")
      if (!opts.nameOrQuery) return usageOutput("Usage: nemo marketplace remove <skill|agent> <name>")
      const result = removeMarketplaceEntry(kind as MarketplaceKind, opts.nameOrQuery, cwd)
      return result.ok ? result.message : failOutput(`Error: ${result.error}`)
    }
    default:
      return usageOutput(`Unknown marketplace action: ${opts.action}. Available: list|search|install|remove`)
  }
}
