/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Junk that must never be collected as tests (also mirrored in
// coverage.exclude below so generated/vendored trees don't skew numbers).
const excludedTrees = [
  "**/node_modules/**",
  "**/dist/**",
  "**/tui.bak/**",
  "**/legacy-reference-tui/**",
  "**/legacy-reference-tui2/**",
  // NOTE: **/trayambak-ink/** used to be excluded here — the fork's own
  // 7-test suite is ENABLED: its `bun:test` imports resolve through the
  // resolve.alias below, and its phantom @claude-code/repl dependency
  // (registry E404) is vendored in-tree at
  // packages/trayambak-ink/vendor/claude-code-repl (installed file: at the
  // root). Fork coverage stays out of the repo ratchet via the explicit
  // `packages/trayambak-ink/**` entry in coverage.exclude below.
  "**/repl/**",
]

export default defineConfig({
  // The fork's suite was written against bun's test runner; map `bun:test`
  // to vitest (describe/expect/test are API-compatible for these files).
  resolve: {
    alias: {
      "bun:test": "vitest",
      // bun's compile-time feature-flag module: the runtime stand-in keeps
      // every optional branch off (see vendor/bun-bundle.js).
      "bun:bundle": fileURLToPath(new URL("./packages/trayambak-ink/vendor/bun-bundle.js", import.meta.url)),
    },
  },
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
        // Smoke sandboxes (/tmp scratch under .smoke-tmp) are harness
        // scratch, never product code — instrumented copies of smoke
        // drivers used to leak into the summary as 0%-covered files.
        ".smoke-tmp/**",
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
      // Coverage floor, measured from `npm run test:coverage` on 2026-09-29
      // (execpolicy suite + redaction tests added; docs/CI recalibrated):
      //   repo   57.11 stmt / 75.73 branch / 65.81 func / 57.11 lines
      //   core   81.54 stmt / 87.07 branch / 85.03 func / 81.54 lines
      // Each figure sits ~2 points below the measured actual. These are a
      // ratchet rather than a target: the number may only rise, so new
      // code has to land with tests or CI goes red. Recalibrate after every
      // merge or scope change by re-running `npm run test:coverage`.
      thresholds: {
        statements: 55,
        branches: 73,
        functions: 63,
        lines: 55,
        // packages/core holds the agent loop, approvals, hook runtime, budget
        // and sandbox — the security-critical spine, and the place a silent
        // regression would do the most damage. It is held to a higher bar than
        // the repository as a whole.
        "packages/core/src/**": {
          statements: 79,
          branches: 85,
          functions: 83,
          lines: 79,
        },
      },
      // Still write the report when a test fails, so failures don't also
      // swallow the artifact (exit code is unaffected — tests still fail).
      reportOnFailure: true,
    },
  },
})
