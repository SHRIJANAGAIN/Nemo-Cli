/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
      "bun:bundle": fileURLToPath(new URL("./packages/nemo-ink/vendor/bun-bundle.js", import.meta.url)),
      // The @claude-code/* packages are file: deps of packages/nemo-ink that
      // the registry does not serve, so they are vendored in-tree instead.
      "@claude-code/repl": fileURLToPath(
        new URL("./packages/nemo-ink/vendor/claude-code-repl", import.meta.url),
      ),
      "@claude-code/output": fileURLToPath(
        new URL("./packages/nemo-ink/vendor/claude-code-output", import.meta.url),
      ),
      "@claude-code/local-observability": fileURLToPath(
        new URL("./packages/nemo-ink/vendor/claude-code-local-observability", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "packages/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "apps/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "hooks/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "servers/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "nemo/**/*.{test,spec}.?(c|m)[jt]s?(x)",
      "packages/sandbox/**/*.test.ts",
      "packages/core/**/*.test.ts",
      "packages/execpolicy/**/*.test.ts",
    ],
    exclude: [...excludedTrees],
    setupFiles: ["./vitest.setup.ts"],

    /*
     * Concurrency and timeout, both set by what these tests actually DO.
     *
     * This suite spawns real child processes — `setInterval(() => {}, 1000)`
     * loops that a test then waits on and kills — and asserts on timing windows
     * that are deliberately short: `IO_DRAIN_TIMEOUT_MS` is 2s by design in
     * core/src/process.ts. Under Vitest's default thread pool on a 16-core box
     * (15 workers), several of those files run at once, each holding OS
     * processes, and the windows blow.
     *
     * The signature was unmistakable once the failures were read rather than
     * counted: three of them were literally `Test timed out in 5000ms`, and
     * every affected file passes when run alone. That is contention, not
     * flakiness, and it is worth naming because "flake" is what you write when
     * you have not checked.
     *
     * Two settings, two reasons:
     *
     *  - **maxThreads 8.** Half the cores, leaving headroom for the children the
     *    tests themselves spawn. The alternative — raising the timeout until a
     *    loaded run passes — hides the contention instead of removing it, and
     *    makes a genuine hang take three times as long to report.
     *  - **testTimeout 20s.** Vitest's 5s default is shorter than the behaviour
     *    under test: a test whose subject is "survives commands longer than the
     *    IO drain window" must first outlast that window, then prove it, on a
     *    loaded machine. This does not paper over a hang; a real hang still
     *    fails, just with enough room for the legitimate case to finish.
     */
    poolOptions: {
      threads: {
        maxThreads: 8,
        minThreads: 1,
      },
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
        "packages/nemo-ink/**",
        // apps/** and nemo/** are PRODUCT code and must stay in scope — a
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
