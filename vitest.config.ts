/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { defineConfig } from "vitest/config"

// Junk that must never be collected as tests (also mirrored in
// coverage.exclude below so generated/vendored trees don't skew numbers).
const excludedTrees = [
  "**/node_modules/**",
  "**/dist/**",
  "**/tui.bak/**",
  "**/legacy-reference-tui/**",
  "**/legacy-reference-tui2/**",
  "**/trayambak-ink/**",
  "**/repl/**",
]

export default defineConfig({
  test: {
    include: [
      "packages/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "apps/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "hooks/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "servers/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "skt/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "packages/sandbox/**/*.test.ts",
      "packages/core/**/*.test.ts",
      "packages/execpolicy/**/*.test.ts",
    ],
    exclude: [...excludedTrees],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary", "html"],
      reportsDirectory: "coverage/",
      exclude: [
        ...excludedTrees,
        "**/*.test.ts",
        "**/*.spec.ts",
        "**/*.test.tsx",
        "**/*.spec.tsx",
        "dist/**",
        "node_modules/**",
        "coverage/**",
        "packages/trayambak-ink/**",
        // apps/** and skt/** are PRODUCT code and must stay in scope — a
        // blanket exclusion for them once shrank the measured set from 45k
        // to 26k statements and inflated the gate by ~8 points. Only the
        // non-product trees below this comment may be excluded.
        // Build/config plumbing, not product code.
        "**/*.d.ts",
        "**/vitest.config.ts",
        "**/tsconfig*.json",
        "eslint.config.mjs",
        "fix-esm-imports.js",
        ".github/**",
        "scripts/**",
        "publish/**",
        "backups/**",
        "agent-prompts/**",
        "skills/**",
        "rules/**",
        "docs/**",
        "assets/**",
      ],
      // Gates pinned ~2 points below the measured actuals over the FULL
      // product scope (apps + skt + packages — ~51.5k statements, not the
      // 26k that the removed blanket exclusion had allowed through):
      // 44.22 stmts / 74.23 branches / 53.44 funcs / 44.22 lines
      // (111 test files).
      thresholds: {
        statements: 42,
        branches: 72,
        functions: 51,
        lines: 42,
      },
      // Still write the report when a test fails, so failures don't also
      // swallow the artifact (exit code is unaffected — tests still fail).
      reportOnFailure: true,
    },
  },
})
