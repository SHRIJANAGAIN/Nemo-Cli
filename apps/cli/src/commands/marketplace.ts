/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import {
  defaultMarketplaceSource,
  installMarketplaceEntry,
  removeMarketplaceEntry,
  scanMarketplace,
  searchMarketplace,
  type MarketplaceKind,
} from "../../../runtime/src/tools/marketplace/marketplace.js"

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

/** `trayambak marketplace <list|search|install|remove>`: shelf CLI twin. */
export function marketplaceCommand(opts: MarketplaceOptions): string {
  const action = (opts.action ?? "list").trim().toLowerCase()
  const source = opts.source && opts.source.length > 0 ? opts.source : defaultMarketplaceSource()
  const cwd = opts.cwd ?? process.cwd()
  switch (action) {
    case "list":
      return entriesText(scanMarketplace(source))
    case "search": {
      if (!opts.nameOrQuery) return "Usage: trayambak marketplace search <query> [--source <dir>]"
      const hits = searchMarketplace(source, opts.nameOrQuery)
      return hits.length > 0 ? entriesText(hits) : `No marketplace entries match '${opts.nameOrQuery}'.`
    }
    case "install": {
      const kind = (opts.kind ?? "").trim().toLowerCase()
      if (kind !== "skill" && kind !== "agent")
        return "Usage: trayambak marketplace install <skill|agent> <name> [--source <dir>]"
      if (!opts.nameOrQuery) return "Usage: trayambak marketplace install <skill|agent> <name> [--source <dir>]"
      const result = installMarketplaceEntry(source, kind as MarketplaceKind, opts.nameOrQuery, cwd)
      return result.ok ? result.message : `Error: ${result.error}`
    }
    case "remove": {
      const kind = (opts.kind ?? "").trim().toLowerCase()
      if (kind !== "skill" && kind !== "agent") return "Usage: trayambak marketplace remove <skill|agent> <name>"
      if (!opts.nameOrQuery) return "Usage: trayambak marketplace remove <skill|agent> <name>"
      const result = removeMarketplaceEntry(kind as MarketplaceKind, opts.nameOrQuery, cwd)
      return result.ok ? result.message : `Error: ${result.error}`
    }
    default:
      return `Unknown marketplace action: ${opts.action}. Available: list|search|install|remove`
  }
}
