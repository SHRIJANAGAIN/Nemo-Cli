// Flat config for ESLint 9. Run: npm run lint
import tseslint from "typescript-eslint"
import { plugin } from "./packages/eslint-plugin-nemo/src/index.mjs"

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "publish/**",
      "packages/tui.bak/**",
      "bin/**",
      "*.mjs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx", "nemo/**/*.ts"],
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
    // AGENTS.md "Lint Rules (16)" — severities are part of the spec and must
    // never be weakened here. Rule implementations live in
    // packages/eslint-plugin-nemo/src/index.mjs.
    files: ["apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.ts", "packages/**/*.tsx", "nemo/**/*.ts"],
    plugins: { nemo: plugin },
    rules: {
      // 11 errors
      "nemo/no-ambiguous-boolean": "error",
      "nemo/no-cross-package-import": "error",
      "nemo/hook-timeout-required": "error",
      "nemo/no-sandbox-env-touch": "error",
      "nemo/no-any-type": "error",
      "nemo/require-tool-timeout": "error",
      "nemo/no-hardcoded-secrets": "error",
      "nemo/no-unbounded-exec": "error",
      "nemo/no-duplicate-exports": "error",
      "nemo/approval-mode-exhaustive": "error",
      "nemo/max-file-size": "error",
      // 4 warnings
      "nemo/no-console-in-core": "warn",
      "nemo/no-direct-process-env": "warn",
      "nemo/require-singleton-accessor": "warn",
      "nemo/no-todo-without-issue": "warn",
      // Documented placeholder — AGENTS.md wires this rule as "off".
      "nemo/test-requires-timeout-assert": "off",
    },
  },
  {
    // MUST stay after the nemo block (flat-config order: later wins).
    // AGENTS.md's test rules require tests to clear/pin ambient env
    // (`Clear MODEL_NAME/MODEL_PROVIDER/NEMO_* or pin overrides`), so
    // direct process.env access IS the sanctioned pattern in tests; the
    // rule guards production code paths only.
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: { "nemo/no-direct-process-env": "off" },
  },
)
