// Flat config for ESLint 9. Run: npm run lint
import tseslint from "typescript-eslint"
import { plugin } from "./packages/eslint-plugin-trayambak/src/index.mjs"

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "publish/**",
      "packages/tui.bak/**",
      "packages/trayambak-ink/**",
      "bin/**",
      "*.mjs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx", "skt/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // AGENTS.md "Lint Rules (15)" — severities are part of the spec and must
    // never be weakened here. Rule implementations live in
    // packages/eslint-plugin-trayambak/src/index.mjs.
    files: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx", "skt/**/*.ts"],
    plugins: { trayambak: plugin },
    rules: {
      // 10 errors
      "trayambak/no-ambiguous-boolean": "error",
      "trayambak/no-cross-package-import": "error",
      "trayambak/hook-timeout-required": "error",
      "trayambak/no-sandbox-env-touch": "error",
      "trayambak/no-any-type": "error",
      "trayambak/require-tool-timeout": "error",
      "trayambak/no-hardcoded-secrets": "error",
      "trayambak/no-unbounded-exec": "error",
      "trayambak/no-duplicate-exports": "error",
      "trayambak/approval-mode-exhaustive": "error",
      // 4 warnings
      "trayambak/no-console-in-core": "warn",
      "trayambak/no-direct-process-env": "warn",
      "trayambak/require-singleton-accessor": "warn",
      "trayambak/no-todo-without-issue": "warn",
      // Documented placeholder — AGENTS.md wires this rule as "off".
      "trayambak/test-requires-timeout-assert": "off",
    },
  },
  {
    // MUST stay after the trayambak block (flat-config order: later wins).
    // AGENTS.md's test rules require tests to clear/pin ambient env
    // (`Clear MODEL_NAME/MODEL_PROVIDER/TRAYAMBAK_* or pin overrides`), so
    // direct process.env access IS the sanctioned pattern in tests; the
    // rule guards production code paths only.
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: { "trayambak/no-direct-process-env": "off" },
  },
)
