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
      // Coverage floor, measured from `npm run test:coverage` on 2026-09-28
      // after the live-side merge (both test suites in the tree):
      //   repo   48.99 stmt / 74.61 branch / 60.77 func / 48.99 lines
      //   core   79.09 stmt / 87.40 branch / 82.73 func / 79.09 lines
      // Each figure sits ~2 points below the measured actual. These are a
      // ratchet rather than a target: the number may only rise, so new
      // code has to land with tests or CI goes red. Recalibrate after every
      // merge or scope change by re-running `npm run test:coverage`.
      thresholds: {
        statements: 47,
        branches: 73,
        functions: 59,
        lines: 47,
        // packages/core holds the agent loop, approvals, hook runtime, budget
        // and sandbox — the security-critical spine, and the place a silent
        // regression would do the most damage. It is held to a higher bar than
        // the repository as a whole (AGENTS.md: "Coverage threshold: 42%
        // minimum across packages/core/src/**/*.ts").
        "packages/core/src/**": {
          statements: 77,
          branches: 85,
          functions: 80,
          lines: 77,
        },
      },
      // Still write the report when a test fails, so failures don't also
      // swallow the artifact (exit code is unaffected — tests still fail).
      reportOnFailure: true,
    },
  },
})
