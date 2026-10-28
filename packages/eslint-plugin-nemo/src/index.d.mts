/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Type declarations for ./index.mjs — the nemo ESLint plugin.
 * The repo typechecks packages TS sources (the test file imports the .mjs
 * through this declaration), so everything exported from index.mjs must be
 * described here structurally against ESLint's own bundled types.
 */
import type { Rule } from "eslint"

export interface NemoPlugin {
  name: string
  version: string
  meta: { name: string; version: string }
  rules: Record<string, Rule.RuleModule>
}

export const rules: Record<string, Rule.RuleModule>
export const plugin: NemoPlugin
export default plugin
