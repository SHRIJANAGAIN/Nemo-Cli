/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Unit tests for every rule in eslint-plugin-trayambak (AGENTS.md
 * "Lint Rules (15)"). Each rule gets at least one violation case and one
 * clean case; tricky semantics (param comments, placeholders, deferred
 * boundaries, allowlists) are covered explicitly. Cases run through
 * ESLint's Linter with the TypeScript parser so TS-only nodes (any
 * keywords, private fields, annotations) are exercised for real.
 */
import { Linter } from "eslint"
import path from "node:path"
import tseslint from "typescript-eslint"
import { describe, expect, it } from "vitest"
import { plugin, rules } from "./index.mjs"

const linter = new Linter()

/**
 * Lint `code` with exactly one trayambak rule enabled at "error".
 *
 * `filename` is repo-relative (what a human reads in a test); it is resolved
 * to an absolute path here because that is exactly what the ESLint CLI hands
 * `context.filename`, and because flat-config Linter only applies a config
 * object to filenames its `files` globs match — absolute paths outside cwd
 * never match, which would surface as "No matching configuration found"
 * instead of a rule result.
 */
function lint(code: string, ruleId: string, filename = "packages/example/src/sample.ts"): Linter.LintMessage[] {
  const config: Linter.FlatConfig[] = [
    {
      files: ["**/*.ts", "**/*.tsx"],
      plugins: { trayambak: plugin },
      languageOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
      },
      rules: { [`trayambak/${ruleId}`]: "error" },
    },
  ]
  return linter.verify(code, config, path.resolve(filename))
}

/** Every rule must be exported under its AGENTS.md name. */
describe("plugin surface", () => {
  it("exports all fifteen rules", () => {
    expect(Object.keys(rules).sort()).toEqual(
      [
        "approval-mode-exhaustive",
        "hook-timeout-required",
        "no-ambiguous-boolean",
        "no-any-type",
        "no-console-in-core",
        "no-cross-package-import",
        "no-direct-process-env",
        "no-duplicate-exports",
        "no-hardcoded-secrets",
        "no-sandbox-env-touch",
        "no-todo-without-issue",
        "no-unbounded-exec",
        "require-singleton-accessor",
        "require-tool-timeout",
        "test-requires-timeout-assert",
      ].sort(),
    )
  })

  it("declares meta.docs, schema and messages on every rule", () => {
    for (const rule of Object.values(rules)) {
      expect(rule.meta).toBeDefined()
      expect(rule.meta?.docs?.description).toBeTruthy()
      expect(rule.meta?.schema).toEqual([])
      expect(rule.meta?.messages).toBeDefined()
      expect(Object.keys(rule.meta?.messages ?? {}).length).toBeGreaterThan(0)
    }
  })
})

describe("no-ambiguous-boolean", () => {
  it("flags a bare boolean first argument", () => {
    const messages = lint("function enable(flag: boolean) {}\nenable(true)", "no-ambiguous-boolean")
    expect(messages).toHaveLength(1)
    expect(messages[0].ruleId).toBe("trayambak/no-ambiguous-boolean")
    expect(messages[0].messageId).toBe("ambiguousBoolean")
  })

  it("flags a bare boolean trailing argument", () => {
    expect(lint("connect(host, false)", "no-ambiguous-boolean")).toHaveLength(1)
  })

  it("accepts an adjacent /*param_name*/ comment", () => {
    expect(lint("enable(/*flag*/ true)", "no-ambiguous-boolean")).toHaveLength(0)
  })

  it("ignores if/ternary positions and test files", () => {
    expect(lint("if (true) { run() }", "no-ambiguous-boolean")).toHaveLength(0)
    expect(lint("const x = ready ? true : false", "no-ambiguous-boolean")).toHaveLength(0)
    expect(lint("enable(true)", "no-ambiguous-boolean", "packages/example/src/sample.test.ts")).toHaveLength(0)
  })
})

describe("no-cross-package-import", () => {
  it("flags packages/core importing apps/*", () => {
    const messages = lint(
      'import { run } from "../../../apps/runtime/src/index.js"',
      "no-cross-package-import",
      "packages/core/src/mod.ts",
    )
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("coreToApps")
  })

  it("flags packages/execpolicy importing packages/core", () => {
    const messages = lint(
      'import { evaluate } from "../../core/src/index.js"',
      "no-cross-package-import",
      "packages/execpolicy/src/policy.ts",
    )
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("execpolicyToCore")
  })

  it("flags trayambak-ink deep-importing packages/core/src/*", () => {
    const messages = lint(
      'import { Arsenal } from "../../core/src/toolsets/arsenal.js"',
      "no-cross-package-import",
      "packages/trayambak-ink/src/app.tsx",
    )
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("inkDeepImport")
  })

  it("allows sibling imports and the deferred apps/cli boundary", () => {
    expect(
      lint('import { x } from "./sibling.js"', "no-cross-package-import", "packages/core/src/mod.ts"),
    ).toHaveLength(0)
    // Deferred boundary (ENFORCE_APPS_CLI_SCOPE = false): apps/cli importing
    // packages/server is reported by the rule implementation once enabled.
    expect(
      lint(
        'import { s } from "../../../packages/server/src/index.js"',
        "no-cross-package-import",
        "apps/cli/src/index.ts",
      ),
    ).toHaveLength(0)
  })
})

describe("hook-timeout-required", () => {
  it("flags a hook registration without timeoutMs", () => {
    const messages = lint(
      'runtime.register({ name: "permission-check", events: ["tool.use"], mode: "blocking", handler: async () => null })',
      "hook-timeout-required",
    )
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("missingTimeoutMs")
  })

  it("flags a standalone events+handler hook object without timeoutMs", () => {
    expect(lint('const hook = { events: ["stop"], handler: async () => null }', "hook-timeout-required")).toHaveLength(
      1,
    )
  })

  it("accepts registrations that declare timeoutMs", () => {
    expect(
      lint(
        'runtime.register({ name: "permission-check", events: ["tool.use"], mode: "blocking", timeoutMs: 5000, handler: async () => null })',
        "hook-timeout-required",
      ),
    ).toHaveLength(0)
  })

  it("does not flag slash-command definitions ({ name, handler })", () => {
    expect(lint('registry.register({ name: "cmd", handler: async () => null })', "hook-timeout-required")).toHaveLength(
      0,
    )
  })
})

describe("no-sandbox-env-touch", () => {
  // Assembled from parts so this spec file itself never contains the protected
  // marker as a literal — rule 4 would (correctly) flag its own test cases.
  const marker = "TRAYAMBAK" + "_SANDBOX_"

  it("flags an env identifier using the protected marker", () => {
    const messages = lint(`const mode = process.env.${marker}MODE`, "no-sandbox-env-touch")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("sandboxEnvTouch")
  })

  it("flags a string literal mentioning the protected marker", () => {
    expect(lint(`const note = "mentions ${marker} markers"`, "no-sandbox-env-touch")).toHaveLength(1)
  })

  it("exempts sandbox.ts and unrelated names", () => {
    expect(
      lint(`const mode = process.env.${marker}MODE`, "no-sandbox-env-touch", "packages/core/src/sandbox.ts"),
    ).toHaveLength(0)
    expect(lint("const x = process.env.TRAYAMBAK_FEATURE", "no-sandbox-env-touch")).toHaveLength(0)
  })
})

describe("no-any-type", () => {
  it("flags an any annotation", () => {
    const messages = lint("const value: any = 1", "no-any-type")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("explicitAny")
  })

  it("flags an as-any cast and any[]", () => {
    expect(lint("const list = [] as any[]", "no-any-type")).toHaveLength(1)
    expect(lint("function take(x: any) { return x }", "no-any-type")).toHaveLength(1)
  })

  it("accepts unknown, literal and expression positions", () => {
    expect(lint("const value: unknown = 1", "no-any-type")).toHaveLength(0)
    expect(lint('const kind: "any" = "any"', "no-any-type")).toHaveLength(0)
    expect(lint("const schema = z.any()", "no-any-type")).toHaveLength(0)
  })
})

describe("no-console-in-core", () => {
  it("flags console calls inside packages/core", () => {
    const messages = lint('console.log("hello")', "no-console-in-core", "packages/core/src/report.ts")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("consoleInCore")
    expect(lint('console.error("boom")', "no-console-in-core", "packages/core/src/report.ts")).toHaveLength(1)
  })

  it("exempts core tests and non-core files", () => {
    expect(lint('console.log("hello")', "no-console-in-core", "packages/core/src/report.test.ts")).toHaveLength(0)
    expect(lint('console.log("hello")', "no-console-in-core", "apps/cli/src/index.ts")).toHaveLength(0)
  })
})

describe("require-tool-timeout", () => {
  it("flags a ToolDefinition-shaped literal without timeoutMs", () => {
    const messages = lint(
      'const def = { name: "bash", description: "Run a command", parameters: { type: "object" } }',
      "require-tool-timeout",
    )
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("missingTimeoutMs")
  })

  it("flags nested tool definitions too", () => {
    expect(
      lint(
        'export const tools = [{ name: "read", description: "Read a file", parameters: { type: "object" } }]',
        "require-tool-timeout",
      ),
    ).toHaveLength(1)
  })

  it("accepts definitions carrying timeoutMs and non-tool objects", () => {
    expect(
      lint(
        'const def = { name: "bash", description: "Run a command", parameters: { type: "object" }, timeoutMs: 30_000 }',
        "require-tool-timeout",
      ),
    ).toHaveLength(0)
    expect(lint('const notATool = { name: "x", description: "y" }', "require-tool-timeout")).toHaveLength(0)
  })

  it("ignores wire projections of an existing definition (provider adapters)", () => {
    // llama-cpp/nvidia/OpenAI-compatible adapters forward an existing
    // ToolDefinition: all values are pure member reads, never a definition.
    expect(
      lint(
        'const wire = tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))',
        "require-tool-timeout",
      ),
    ).toHaveLength(0)
    expect(
      lint(
        'body.tools = input.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters ?? { type: "object" } }))',
        "require-tool-timeout",
      ),
    ).toHaveLength(0)
  })
})

describe("no-hardcoded-secrets", () => {
  it("flags a realistic ghp_ literal", () => {
    const messages = lint('const leaked = "ghp_XXXXXXXXXXXXXXXXXXXXXXXX"', "no-hardcoded-secrets")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("hardcodedSecret")
  })

  it("flags a long non-placeholder literal bound to a key-like name", () => {
    expect(lint('const apiKey = "4d7c2f9a1b3e5d6c8f0a2b4d6e8c0a1f"', "no-hardcoded-secrets")).toHaveLength(1)
  })

  it("accepts env indirection, placeholders and short values", () => {
    expect(lint("const apiKey = process.env.OPENAI_API_KEY", "no-hardcoded-secrets")).toHaveLength(0)
    expect(lint('const apiKey = "your-api-token-here"', "no-hardcoded-secrets")).toHaveLength(0)
    expect(lint('const secret = "tiny"', "no-hardcoded-secrets")).toHaveLength(0)
    expect(lint('const token = "sk-abcdefghijklmnopqrstuvwxyz012345"', "no-hardcoded-secrets")).toHaveLength(0)
  })
})

describe("no-unbounded-exec", () => {
  it("flags execSync without any options", () => {
    const messages = lint('execSync("ls -la")', "no-unbounded-exec")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("unboundedExec")
    // execSync's options slot is index 1, so the command string must not be
    // mistaken for an options object; spawnSync with only a command is the
    // same shape of hang.
    expect(lint('spawnSync("ls")', "no-unbounded-exec")).toHaveLength(1)
  })

  it("flags an options object missing timeout", () => {
    expect(lint('execFileSync("ls", [], { cwd: "." })', "no-unbounded-exec")).toHaveLength(1)
  })

  it("accepts explicit timeouts and non-literal options", () => {
    expect(lint('execSync("ls", { timeout: 5000 })', "no-unbounded-exec")).toHaveLength(0)
    expect(lint('spawnSync("ls", [], { timeout: 5000, cwd: "." })', "no-unbounded-exec")).toHaveLength(0)
    expect(lint('execSync("ls", options)', "no-unbounded-exec")).toHaveLength(0)
  })
})

describe("no-direct-process-env", () => {
  it("flags process.env.X outside the allowlist", () => {
    const messages = lint("const x = process.env.MODEL_NAME", "no-direct-process-env", "apps/cli/src/commands/serve.ts")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("directProcessEnv")
  })

  it("flags computed access", () => {
    expect(
      lint('setup(process.env["BASE_URL"])', "no-direct-process-env", "apps/cli/src/commands/serve.ts"),
    ).toHaveLength(1)
  })

  it("allows the sanctioned entry points and bare process.env pass-through", () => {
    expect(
      lint("const x = process.env.MODEL_NAME", "no-direct-process-env", "apps/runtime/src/config.ts"),
    ).toHaveLength(0)
    expect(lint("const x = process.env.TOKEN", "no-direct-process-env", "packages/core/src/auth.ts")).toHaveLength(0)
    expect(lint("spawn({ env: process.env })", "no-direct-process-env", "apps/cli/src/commands/serve.ts")).toHaveLength(
      0,
    )
  })
})

describe("require-singleton-accessor", () => {
  it("flags a static private cache without getInstance", () => {
    const messages = lint("class Store { private static instance: Store | null = null }", "require-singleton-accessor")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("missingGetInstance")
  })

  it("flags a static #instance cache without getInstance", () => {
    expect(lint("class Other { static #instance = null }", "require-singleton-accessor")).toHaveLength(1)
  })

  it("accepts classes with getInstance and classes without a cache", () => {
    expect(
      lint(
        "class Store { private static instance: Store | null = null\nstatic getInstance(): Store { return Store.instance as Store } }",
        "require-singleton-accessor",
      ),
    ).toHaveLength(0)
    expect(lint("class Plain { private value = 1 }", "require-singleton-accessor")).toHaveLength(0)
  })
})

describe("no-duplicate-exports", () => {
  it("flags a declaration colliding with a specifier alias", () => {
    const messages = lint("export const x = 1\nconst y = 2\nexport { y as x }", "no-duplicate-exports")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("duplicateExport")
  })

  it("flags two specifiers bound to the same export name", () => {
    expect(lint("const p = 1\nconst q = 2\nexport { p as r, q as r }", "no-duplicate-exports")).toHaveLength(1)
  })

  it("accepts unique names and star re-exports", () => {
    expect(lint("const x = 1\nconst y = 2\nexport { x, y }", "no-duplicate-exports")).toHaveLength(0)
    expect(lint('export * from "./other.js"\nexport const x = 1', "no-duplicate-exports")).toHaveLength(0)
  })
})

describe("test-requires-timeout-assert", () => {
  it("is an inert placeholder (wired as 'off' in AGENTS.md)", () => {
    expect(lint("export const x = 1", "test-requires-timeout-assert")).toHaveLength(0)
  })

  it("never reports until the placeholder is implemented", () => {
    expect(lint("async function t() { await Promise.resolve() }", "test-requires-timeout-assert")).toHaveLength(0)
  })
})

describe("no-todo-without-issue", () => {
  it("flags an untracked marker comment", () => {
    const messages = lint("// TODO: rename this helper", "no-todo-without-issue")
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("todoWithoutIssue")
  })

  it("flags a second marker kind without a reference", () => {
    expect(lint("/* FIXME: broken path handling */", "no-todo-without-issue")).toHaveLength(1)
  })

  it("accepts issue references and plain comments", () => {
    expect(lint("// TODO(#42): rename this helper", "no-todo-without-issue")).toHaveLength(0)
    expect(lint("// FIXME(PROJ-7): broken path handling", "no-todo-without-issue")).toHaveLength(0)
    expect(lint("// just a note", "no-todo-without-issue")).toHaveLength(0)
  })
})

describe("approval-mode-exhaustive", () => {
  it("flags a switch over an approvalMode identifier without default", () => {
    const messages = lint(
      'function f(approvalMode: string) { switch (approvalMode) { case "a": break } }',
      "approval-mode-exhaustive",
    )
    expect(messages).toHaveLength(1)
    expect(messages[0].messageId).toBe("missingDefault")
  })

  it("flags a switch over a member expression of approval state", () => {
    expect(
      lint(
        'function g(state: { approval: string }) { switch (state.approval) { case "x": break } }',
        "approval-mode-exhaustive",
      ),
    ).toHaveLength(1)
  })

  it("accepts a default case and non-approval discriminants", () => {
    expect(
      lint(
        'function h(approvalState: string) { switch (approvalState) { case "a": break; default: break } }',
        "approval-mode-exhaustive",
      ),
    ).toHaveLength(0)
    expect(
      lint('function k(kind: string) { switch (kind) { case "a": break } }', "approval-mode-exhaustive"),
    ).toHaveLength(0)
  })
})
