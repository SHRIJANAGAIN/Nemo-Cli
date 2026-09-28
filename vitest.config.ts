/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { defineConfig } from "vitest/config";

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
];

export default defineConfig({
  test: {
    include: ["packages/**/*.{test,spec}.?(c|m)[jt]s?(x)", "apps/**/*.{test,spec}.?(c|m)[jt]s?(x)", "hooks/**/*.{test,spec}.?(c|m)[jt]s?(x)", "servers/**/*.{test,spec}.?(c|m)[jt]s?(x)", "skt/**/*.{test,spec}.?(c|m)[jt]s?(x)", "packages/sandbox/**/*.test.ts", "packages/core/**/*.test.ts", "packages/execpolicy/**/*.test.ts"],
    exclude: [...excludedTrees],
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
        // Build/config plumbing, not product code.
        "**/*.d.ts",
        "**/vitest.config.ts",
        "**/tsconfig*.json",
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
      // Coverage floor, measured from `npm run test:coverage` on 2026-09-28:
      //   repo   41.95 stmt / 73.16 branch / 50.54 func / 41.95 lines
      //   core   57.42 stmt / 79.06 branch / 68.10 func / 57.42 lines
      // Each figure is rounded down to leave about a point of headroom. These
      // are a ratchet rather than a target: the number may only rise, so new
      // code has to land with tests or CI goes red.
      thresholds: {
        statements: 41,
        branches: 72,
        functions: 50,
        lines: 41,
        // packages/core holds the agent loop, approvals, hook runtime, budget
        // and sandbox — the security-critical spine, and the place a silent
        // regression would do the most damage. It is held to a higher bar than
        // the repository as a whole (AGENTS.md: "Coverage threshold: 42%
        // minimum across packages/core/src/**/*.ts").
        "packages/core/src/**": {
          statements: 55,
          branches: 77,
          functions: 66,
          lines: 55,
        },
      },
      // Still write the report when a test fails, so failures don't also
      // swallow the artifact (exit code is unaffected — tests still fail).
      reportOnFailure: true,
    },
  },
});
