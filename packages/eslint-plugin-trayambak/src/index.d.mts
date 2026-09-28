/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Type declarations for ./index.mjs — the trayambak ESLint plugin.
 * The repo typechecks packages TS sources (the test file imports the .mjs
 * through this declaration), so everything exported from index.mjs must be
 * described here structurally against ESLint's own bundled types.
 */
import type { Rule } from "eslint"

export interface TrayambakPlugin {
  name: string
  version: string
  meta: { name: string; version: string }
  rules: Record<string, Rule.RuleModule>
}

export const rules: Record<string, Rule.RuleModule>
export const plugin: TrayambakPlugin
export default plugin
