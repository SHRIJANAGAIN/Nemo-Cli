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
      // Gates pinned ~2-3 points below the measured actuals from
      // `npm run test:coverage`
      // Updated from 34.79% baseline to target 75%+ with new sandbox/execpolicy/state-db tests
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
      // Still write the report when a test fails, so failures don't also
      // swallow the artifact (exit code is unaffected — tests still fail).
      reportOnFailure: true,
    },
  },
});
