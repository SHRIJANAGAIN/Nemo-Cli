/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * eslint-plugin-nemo — the sixteen lint rules mandated by AGENTS.md
 * ("Lint Rules (16)"). Pure ESM; loaded directly by eslint.config.mjs and
 * unit-tested by src/index.test.ts.
 *
 * Severity assignment lives in eslint.config.mjs (11 error / 4 warn / 1 off),
 * never here — a rule must not weaken itself.
 */
import path from "node:path"

const posix = path.posix

/* ─── shared helpers ─── */

const normalizePath = (value) => String(value ?? "").replace(/\\/g, "/")

/** Prefix with "/" so segment regexes match drive-letter paths too. */
const asSlashPath = (value) => (value.startsWith("/") ? value : `/${value}`)

const isTestFile = (filename) => /\.(?:test|spec)\.tsx?$/.test(normalizePath(filename))

function fileOf(context) {
  return typeof context.filename === "string" && context.filename ? context.filename : context.getFilename()
}

function codeOf(context) {
  return context.sourceCode ?? context.getSourceCode()
}

function propKeyName(prop) {
  if (prop.type !== "Property") return null
  if (prop.key.type === "Identifier") return prop.key.name
  if (prop.key.type === "Literal" && typeof prop.key.value === "string") return prop.key.value
  return null
}

function objectKeyNames(objectExpression) {
  return objectExpression.properties.map(propKeyName).filter((name) => name !== null)
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name
  }
  return null
}

/* ─── 1. no-ambiguous-boolean (error) ─── */

/**
 * A bare `true`/`false` call argument says nothing about what it switches.
 * Require an adjacent `/*param_name*\/` block comment on the same line.
 *
 * Test/spec files are excluded: `expect(x).toBe(true)` compares values, it is
 * not an option flag. if/while/ternary positions are excluded structurally —
 * only direct CallExpression arguments are inspected, so a boolean whose
 * parent is an if/while/ternary/conditional is never reported.
 */
const noAmbiguousBoolean = {
  meta: {
    docs: {
      description:
        "require a /*param_name*/ comment next to bare true/false call arguments (excluded in *.test.ts/*.spec.ts, where booleans are assertion values rather than option flags; if/while/ternary positions are never flagged)",
    },
    schema: [],
    type: "problem",
    messages: {
      ambiguousBoolean:
        "Ambiguous boolean argument '{{value}}' — add an adjacent /*param_name*/ block comment naming the parameter this flag controls.",
    },
  },
  create(context) {
    const filename = fileOf(context)
    if (isTestFile(filename)) return {}
    const sourceCode = codeOf(context)
    return {
      Literal(node) {
        if (node.value !== true && node.value !== false) return
        const parent = node.parent
        if (!parent || parent.type !== "CallExpression") return
        if (!parent.arguments.includes(node)) return
        const prevToken = sourceCode.getTokenBefore(node)
        if (!prevToken) return
        // getCommentsBefore returns exactly the comments between the previous
        // token and this node, i.e. the adjacent-comment slot for an argument.
        const comments = sourceCode.getCommentsBefore(node)
        const annotated = comments.some(
          (comment) =>
            comment.type === "Block" &&
            comment.loc.end.line === node.loc.start.line &&
            /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(comment.value.trim()),
        )
        if (!annotated) {
          context.report({ node, messageId: "ambiguousBoolean", data: { value: String(node.value) } })
        }
      },
    }
  },
}

/* ─── 2. no-cross-package-import (error) ─── */

/**
 * Path-resolving import boundary checks.
 *
 * ACTIVE categories (0 violations after mechanical fixes):
 *   - packages/core must not import apps/*
 *   - packages/execpolicy must not import packages/core
 *   - packages/nemo-ink must not deep-import packages/core/src/*
 *
 * RATCHETED category (enabled):
 *   - "apps/cli imports from packages/core and packages/execpolicy only".
 *     The check is ON. The 9 legacy import sites that exist today are
 *     grandfathered in APPS_CLI_SCOPE_GRANDFATHER below — documented debt
 *     that keeps passing — while ANY apps/cli import of another package
 *     from a file not in that map is an error. The CLI is built on those
 *     packages, so removing the debt needs an architecture migration, not a
 *     mechanical fix. Graduation path: move a site's entry points behind
 *     packages/core (or an apps/cli adapter layer), then delete its
 *     grandfather entry. Never add an entry as a fix; never weaken severity.
 */
const ENFORCE_APPS_CLI_SCOPE = true

/**
 * Grandfathered legacy apps/cli imports: repo-relative file path (relative
 * to apps/cli/, slash-normalized) → the packages outside core/execpolicy it
 * may still import. EXACTLY the 9 sites measured when the ratchet flipped on
 * (index.ts×3, commit.ts + commit.test.ts×2, archive/checkpoint/mcp/sandbox).
 * Migrating a site means deleting its row here — the map only shrinks.
 */
const APPS_CLI_SCOPE_GRANDFATHER = {
  "src/index.ts": ["acp", "mcp-server", "server"],
  "src/commands/archive.ts": ["session-backends"],
  "src/commands/checkpoint.ts": ["checkpoints"],
  "src/commands/commit.ts": ["protocol"],
  "src/commands/commit.test.ts": ["protocol"],
  "src/commands/mcp.ts": ["mcp"],
  "src/commands/sandbox.ts": ["sandbox"],
}

function resolveImportSpecifier(filename, specifier) {
  if (specifier.startsWith(".")) {
    return asSlashPath(posix.normalize(posix.join(posix.dirname(normalizePath(filename)), specifier)))
  }
  if (specifier.startsWith("apps/") || specifier.startsWith("packages/")) {
    return asSlashPath(specifier)
  }
  return null
}

const noCrossPackageImport = {
  meta: {
    docs: {
      description:
        "enforce package import boundaries: packages/core → apps/*, packages/execpolicy → packages/core, packages/nemo-ink → packages/core/src/*, and apps/cli → packages outside core/execpolicy (ratcheted: grandfathered legacy sites pass, new sites error)",
    },
    schema: [],
    type: "problem",
    messages: {
      coreToApps: "packages/core must not import apps/* (resolved to {{target}}).",
      execpolicyToCore: "packages/execpolicy must not import packages/core (resolved to {{target}}).",
      inkDeepImport:
        "packages/nemo-ink must use the core index, not deep-import packages/core/src/* (resolved to {{target}}).",
      appsCliScope: "apps/cli may only import packages/core and packages/execpolicy (resolved to {{target}}).",
    },
  },
  create(context) {
    const filename = normalizePath(fileOf(context))
    const originCore = /\/packages\/core\//.test(filename)
    const originExecpolicy = /\/packages\/execpolicy\//.test(filename)
    const originInk = /\/packages\/nemo-ink\//.test(filename)
    const originAppsCli = /\/apps\/cli\//.test(filename)
    if (!originCore && !originExecpolicy && !originInk && !originAppsCli) return {}

    function check(node, source) {
      if (typeof source !== "string") return
      const resolved = resolveImportSpecifier(filename, source)
      if (resolved === null) return
      const inApps = /\/apps\//.test(resolved)
      const inCore = /\/packages\/core\//.test(resolved)
      const inCoreSrc = /\/packages\/core\/src\//.test(resolved)
      const inPackages = /\/packages\//.test(resolved)
      const inExecpolicy = /\/packages\/execpolicy\//.test(resolved)

      if (originCore && inApps) {
        context.report({ node, messageId: "coreToApps", data: { target: resolved } })
        return
      }
      if (originExecpolicy && inCore) {
        context.report({ node, messageId: "execpolicyToCore", data: { target: resolved } })
        return
      }
      if (originInk && inCoreSrc) {
        context.report({ node, messageId: "inkDeepImport", data: { target: resolved } })
        return
      }
      if (ENFORCE_APPS_CLI_SCOPE && originAppsCli && inPackages && !inCore && !inExecpolicy) {
        const pkgMatch = /\/packages\/([^/]+)\//.exec(resolved)
        const pkg = pkgMatch ? pkgMatch[1] : ""
        const rel = filename.replace(/^.*\/apps\/cli\//, "")
        const grandfathered = APPS_CLI_SCOPE_GRANDFATHER[rel]
        if (!grandfathered || !grandfathered.includes(pkg)) {
          context.report({ node, messageId: "appsCliScope", data: { target: resolved } })
        }
      }
    }

    return {
      ImportDeclaration(node) {
        check(node, node.source.value)
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value)
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node, node.source.value)
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments.length > 0) {
          const first = node.arguments[0]
          if (first && first.type === "Literal" && typeof first.value === "string") check(first, first.value)
        }
      },
    }
  },
}

/* ─── 3. hook-timeout-required (error) ─── */

/**
 * A hook registration (HookRegistration in packages/core/src/hook_runtime.ts:
 * { name, events, handler, mode, timeoutMs }) must declare timeoutMs — the
 * runtime races every handler against hook.timeoutMs, so a missing timeout
 * has no defined behavior. Flags object literals that carry the hook shape
 * (events + handler) or are passed directly to a `.register(...)` call with
 * an `events` list. CLI slash-command definitions ({ name, handler }) are not
 * lifecycle hooks and are intentionally not matched.
 */
const hookTimeoutRequired = {
  meta: {
    docs: {
      description:
        "hook definitions passed to the hook registration API (or matching its events+handler shape) must include timeoutMs",
    },
    schema: [],
    type: "problem",
    messages: {
      missingTimeoutMs:
        "Hook definition '{{name}}' is missing required 'timeoutMs' — the hook runtime enforces execution deadlines.",
    },
  },
  create(context) {
    return {
      ObjectExpression(node) {
        const keys = objectKeyNames(node)
        const hasEvents = keys.includes("events")
        const hasHandler = keys.includes("handler")
        if (!hasEvents || !(hasHandler || isDirectRegisterArg(node))) return
        if (keys.includes("timeoutMs")) return
        const nameProp = node.properties.find((prop) => propKeyName(prop) === "name")
        const name =
          nameProp && nameProp.value && nameProp.value.type === "Literal" ? String(nameProp.value.value) : "(anonymous)"
        context.report({ node, messageId: "missingTimeoutMs", data: { name } })
      },
    }

    function isDirectRegisterArg(objectNode) {
      const parent = objectNode.parent
      if (!parent || parent.type !== "CallExpression" || !parent.arguments.includes(objectNode)) return false
      return calleeName(parent.callee) === "register"
    }
  },
}

/* ─── 4. no-sandbox-env-touch (error) ─── */

/**
 * Sandbox env markers gate nested-sandbox tests and belong to the env
 * filter (packages/core/src/env_filter.ts, which stamps them) and the
 * sandbox package (packages/sandbox/, which reads them) alone. The
 * previously guarded marker string existed in no code, and the old
 * packages/core/src/sandbox.ts home never existed — both pointed at
 * ghosts. References anywhere else are reported.
 *
 * The marker below is assembled from parts so this rule file never
 * contains the literal (the forbidden-strings CI would flag its own
 * linter otherwise). Test files are exempt: specs pinning the marker
 * contract must be allowed to name it.
 */
const SANDBOX_ENV_MARKER = "NEMO" + "_SANDBOX"
const SANDBOX_ALLOWED_PREFIXES = ["/packages/sandbox/", "/packages/core/src/env_filter.ts"]
const SANDBOX_TEST_FILE = /\.test\.(ts|tsx|js|mjs)$/

const noSandboxEnvTouch = {
  meta: {
    docs: {
      description: "forbid sandbox env markers outside packages/sandbox/ and packages/core/src/env_filter.ts",
    },
    schema: [],
    type: "problem",
    messages: {
      sandboxEnvTouch: "'{{marker}}' may only be referenced from packages/sandbox/ or packages/core/src/env_filter.ts.",
    },
  },
  create(context) {
    const filename = normalizePath(fileOf(context))
    if (SANDBOX_ALLOWED_PREFIXES.some((p) => filename.includes(p))) return {}
    if (SANDBOX_TEST_FILE.test(filename)) return {}

    function check(node, name) {
      if (typeof name === "string" && name.includes(SANDBOX_ENV_MARKER)) {
        context.report({ node, messageId: "sandboxEnvTouch", data: { marker: name } })
      }
    }

    return {
      Identifier(node) {
        check(node, node.name)
      },
      PrivateIdentifier(node) {
        check(node, node.name)
      },
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value)
      },
    }
  },
}

/* ─── 5. no-any-type (error) ─── */

/**
 * Bans `any` in every type position: `: any`, `as any`, `<any>` casts,
 * `any[]`, `Array<any>`, generic arguments, catch-clause annotations — all
 * surface as TSAnyKeyword in the AST. Equivalent detection to
 * @typescript-eslint/no-explicit-any (which stays off); implemented here so
 * the rule ships with this plugin and is severitied by AGENTS.md.
 */
const noAnyType = {
  meta: {
    docs: {
      description: "ban the `any` type in any type position (annotation, cast, generic argument, array element)",
    },
    schema: [],
    type: "problem",
    messages: {
      explicitAny: "Unexpected `any` — use a concrete type, `unknown` with narrowing, or a generic parameter.",
    },
  },
  create(context) {
    return {
      TSAnyKeyword(node) {
        context.report({ node, messageId: "explicitAny" })
      },
    }
  },
}

/* ─── 6. no-console-in-core (warn) ─── */

/**
 * packages/core must report through the sanctioned analytics/telemetry path,
 * not console.*. Test files are excluded (assertions and debugging output are
 * fine in tests).
 */
const noConsoleInCore = {
  meta: {
    docs: {
      description:
        "packages/core must not call console.* (non-test files) — use the analytics/telemetry reporting path",
    },
    schema: [],
    type: "suggestion",
    messages: {
      consoleInCore: "Avoid console.{{method}}() in packages/core — report through the analytics/telemetry path.",
    },
  },
  create(context) {
    const filename = normalizePath(fileOf(context))
    if (!filename.includes("/packages/core/")) return {}
    if (isTestFile(filename)) return {}
    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== "MemberExpression" || callee.computed) return
        if (callee.object.type !== "Identifier" || callee.object.name !== "console") return
        if (callee.property.type !== "Identifier") return
        context.report({ node, messageId: "consoleInCore", data: { method: callee.property.name } })
      },
    }
  },
}

/* ─── 7. require-tool-timeout (error) ─── */

/**
 * Tool definition literals follow the ToolDefinition shape found throughout
 * apps/runtime/src/tools: an object literal with `name` + `parameters`
 * (plus `description`). Every tool definition must carry `timeoutMs` so the
 * harness can bound tool execution; unbounded tools can wedge a turn.
 *
 * Exception — wire projections: provider adapters re-encode an existing
 * ToolDefinition for the wire (`function: { name: tool.name, … }` for
 * llama-cpp/nvidia/OpenAI-compatible APIs, `functionDeclarations` for Gemini).
 * Those objects define nothing; they forward a definition that already
 * carries timeoutMs, and growing provider-visible payloads with harness
 * metadata would be a protocol change, not a lint fix. A projection is
 * recognized as name + parameters values that are all member/logical
 * expressions (pure reads off another object), never literal definitions.
 */
function isWireProjection(node) {
  const reading = (value) =>
    value &&
    (value.type === "MemberExpression" ||
      value.type === "OptionalMemberExpression" ||
      value.type === "LogicalExpression")
  const byKey = new Map()
  for (const prop of node.properties) {
    if (prop.type !== "Property" || prop.computed) continue
    const key = propKeyName(prop)
    if (key) byKey.set(key, prop.value)
  }
  return reading(byKey.get("name")) && reading(byKey.get("parameters"))
}

const requireToolTimeout = {
  meta: {
    docs: {
      description: "tool definition object literals (name + parameters, per ToolDefinition) must include timeoutMs",
    },
    schema: [],
    type: "problem",
    messages: {
      missingTimeoutMs: "Tool definition '{{name}}' is missing required 'timeoutMs'.",
    },
  },
  create(context) {
    return {
      ObjectExpression(node) {
        const keys = objectKeyNames(node)
        if (!keys.includes("name") || !keys.includes("parameters")) return
        if (keys.includes("timeoutMs")) return
        if (isWireProjection(node)) return
        const nameProp = node.properties.find((prop) => propKeyName(prop) === "name")
        const name =
          nameProp && nameProp.value && nameProp.value.type === "Literal" ? String(nameProp.value.value) : "(anonymous)"
        context.report({ node, messageId: "missingTimeoutMs", data: { name } })
      },
    }
  },
}

/* ─── 8. no-hardcoded-secrets (error) ─── */

/**
 * Conservative credential detection — false positives block the gate, so:
 *   - direct prefixes require realistic lengths (sk- ≥16, ghp_ ≥20, …);
 *   - the name path (identifier/property matching /key|token|secret|password/i)
 *     only fires for string literals ≥16 chars;
 *   - obvious placeholders are exempt on BOTH paths: "", changeme, your-…,
 *     example/placeholder/dummy/fake/sample/redacted/test, `${…}` / `<…>`
 *     templates, all-caps key names (i18n message ids), synthetic sequences
 *     (abcdef / abc123 / 0123456789 / full alphabet), and any
 *     process.env/template indirection (never a plain literal to begin with).
 */
const DIRECT_SECRET_PATTERNS = [
  { pattern: /^sk-[A-Za-z0-9_-]{16,}$/, label: "sk-" },
  { pattern: /^ghp_[A-Za-z0-9]{20,}$/, label: "ghp_" },
  { pattern: /^github_pat_[A-Za-z0-9_]{20,}$/, label: "github_pat_" },
  { pattern: /^AKIA[0-9A-Z]{16}$/, label: "AKIA" },
  { pattern: /^-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: "PEM" },
]

const SECRET_NAME_RE = /key|token|secret|password/i

const PLACEHOLDER_PATTERNS = [
  /example/i, // AWS/ provider documentation samples (AKIA…EXAMPLE)
  /placeholder/i,
  /changeme/i,
  /change[-_]?me/i,
  /dummy/i,
  /\bfake\b/i,
  /\bsample\b/i,
  /redacted/i,
  /your[-_]/i,
  /insert[-_]/i,
  /replace[-_]?me/i,
  /abcdef/i,
  /abc123/i,
  /0123456789/i,
  /abcdefghijklmnopqrstuvwxyz/i,
  /\$\{/,
  /<[^>]+>/,
  /process\.env/i,
  /\btest/i,
]

function isPlaceholder(value) {
  if (value === "") return true
  if (/^[A-Z0-9_$-]+$/.test(value)) return true // all-caps key name, not a value
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))
}

const noHardcodedSecrets = {
  meta: {
    docs: {
      description:
        "string literals that look like credentials (sk-/ghp_/github_pat_/AKIA/PEM, or long key/token/secret/password assignments) must not be hardcoded; obvious placeholders are exempt",
    },
    schema: [],
    type: "problem",
    messages: {
      hardcodedSecret: "Hardcoded credential{{detail}} — load it from env or the auth store instead.",
    },
  },
  create(context) {
    function reportLiteral(node, matchedLabel) {
      const detail = matchedLabel ? ` ('${matchedLabel}' prefix)` : ""
      context.report({ node, messageId: "hardcodedSecret", data: { detail } })
    }

    function matchesDirectPattern(value) {
      return DIRECT_SECRET_PATTERNS.some(({ pattern }) => pattern.test(value))
    }

    function checkDirect(node) {
      const matched = DIRECT_SECRET_PATTERNS.find(({ pattern }) => pattern.test(node.value))
      if (!matched) return
      if (isPlaceholder(node.value)) return // synthetic test vectors are not credentials
      reportLiteral(node, matched.label)
    }

    function checkNamed(node, value) {
      if (matchesDirectPattern(value)) return // already reported by the Literal visitor
      if (value.length < 16) return
      if (isPlaceholder(value)) return
      reportLiteral(node, "")
    }

    return {
      Literal(node) {
        if (typeof node.value !== "string") return
        checkDirect(node)
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || !node.init) return
        if (!SECRET_NAME_RE.test(node.id.name)) return
        if (node.init.type !== "Literal" || typeof node.init.value !== "string") return // env/template indirection is fine
        checkNamed(node.init, node.init.value)
      },
      Property(node) {
        const name = propKeyName(node)
        if (name === null || !SECRET_NAME_RE.test(name)) return
        if (node.value.type !== "Literal" || typeof node.value.value !== "string") return
        checkNamed(node.value, node.value.value)
      },
      AssignmentExpression(node) {
        if (node.left.type !== "Identifier") return
        if (!SECRET_NAME_RE.test(node.left.name)) return
        if (node.right.type !== "Literal" || typeof node.right.value !== "string") return
        checkNamed(node.right, node.right.value)
      },
    }
  },
}

/* ─── 9. no-unbounded-exec (error) ─── */

/**
 * execSync/execFileSync/spawnSync block the event loop; without an explicit
 * `timeout` option they can hang a turn forever. The options object must be a
 * literal for the check to be conclusive — an options identifier or a spread
 * whose timeout may arrive through the spread is not reported (documented
 * static-analysis limit, no false positives).
 *
 * The options slot depends on the signature: execSync(command, options) puts
 * it at index 1, while execFileSync(file, args?, options?) and
 * spawnSync(command, args?, options?) put it at index 2 when the middle args
 * list is present and at index 1 when it is omitted. Taking "the last
 * argument" instead would mistake a command string for the options object and
 * miss the common execSync("git status") hang.
 */
const SYNC_EXEC_FUNCTIONS = new Set(["execSync", "execFileSync", "spawnSync"])

/** Options argument node for a sync-exec call, or `undefined` when the slot is empty. */
function syncExecOptionsArg(name, args) {
  if (name === "execSync") return args[1]
  const second = args[1]
  if (second === undefined) return undefined
  if (second.type === "ArrayExpression" || second.type === "SpreadElement") return args[2]
  return second
}

const noUnboundedExec = {
  meta: {
    docs: {
      description: "execSync/execFileSync/spawnSync calls must pass an options object containing an explicit timeout",
    },
    schema: [],
    type: "problem",
    messages: {
      unboundedExec: "{{fn}}() without a 'timeout' option can hang forever — pass { timeout: N }.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node.callee)
        if (!name || !SYNC_EXEC_FUNCTIONS.has(name)) return
        if (node.arguments.length === 0) return // no command — fails fast, cannot hang
        const options = syncExecOptionsArg(name, node.arguments)
        if (options === undefined) {
          // Options slot is empty → nothing could carry a timeout.
          context.report({ node, messageId: "unboundedExec", data: { fn: name } })
          return
        }
        if (options.type !== "ObjectExpression") {
          // A non-literal options argument cannot be verified statically.
          return
        }
        const keys = objectKeyNames(options)
        if (keys.includes("timeout")) return
        if (options.properties.some((prop) => prop.type === "SpreadElement")) return
        context.report({ node, messageId: "unboundedExec", data: { fn: name } })
      },
    }
  },
}

/* ─── 10. no-direct-process-env (warn) ─── */

/**
 * AGENTS.md: "All environment variable filtering goes through env_filter.ts.
 * Never inline env checks." env_filter.ts is the single sanctioned gateway.
 *
 * The count of raw process.env.X accesses across the repo is enormous (>150),
 * so per AGENTS.md the sanctioned env-reading entry points are allowlisted
 * here — each entry documents WHY it is sanctioned. The rule is never
 * silenced: it stays enabled (warn) for every other file. Additional entries
 * require an AGENTS.md sanction, not convenience.
 */
const ENV_ALLOWLIST = [
  {
    path: "packages/core/src/env_filter.ts",
    why: "this file IS the sanctioned env gateway (AGENTS.md: all env filtering goes through env_filter.ts)",
  },
  {
    path: "apps/runtime/src/config.ts",
    why: "config loader — 'env' is a sanctioned layer of the AGENTS.md config hierarchy (defaults < global < project < env < CLI flags); it is the single reader for model/agent settings",
  },
  {
    path: "apps/cli/src/index.ts",
    why: "CLI dispatcher — sanctioned entry point that merges flags/env before handing off to the runtime",
  },
  {
    path: "packages/core/src/auth.ts",
    why: "auth-style token store — AGENTS.md Auth Rules: env tokens (NEMO_API_KEY/OPENAI_API_KEY) win over the file store",
  },
]

const noDirectProcessEnv = {
  meta: {
    docs: {
      description:
        "process.env.X access outside the sanctioned env gateway (env_filter.ts) and the documented env-reading entry points",
    },
    schema: [],
    type: "suggestion",
    messages: {
      directProcessEnv:
        "Inline process.env.{{name}} access — route env reads through the sanctioned gateway (packages/core/src/env_filter.ts).",
    },
  },
  create(context) {
    const filename = normalizePath(fileOf(context))
    const allowlisted = ENV_ALLOWLIST.some((entry) => filename.endsWith(entry.path))
    if (allowlisted) return {}

    return {
      MemberExpression(node) {
        const envRef = node.object
        if (!envRef || envRef.type !== "MemberExpression") return
        if (envRef.object.type !== "Identifier" || envRef.object.name !== "process") return
        if (envRef.computed || envRef.property.type !== "Identifier" || envRef.property.name !== "env") return
        const accessed = !node.computed && node.property.type === "Identifier" ? node.property.name : "(computed)"
        context.report({ node, messageId: "directProcessEnv", data: { name: accessed } })
      },
    }
  },
}

/* ─── 11. require-singleton-accessor (warn) ─── */

const SINGLETON_CACHE_RE = /^(?:#|_)?(?:instance|singleton|sInstance|INSTANCE)$/i
const SINGLETON_STATIC_NAMES = new Set(["getInstance", "get_instance", "instance"])

const requireSingletonAccessor = {
  meta: {
    docs: {
      description: "a class holding a static private/#instance cache must expose a static getInstance() accessor",
    },
    schema: [],
    type: "suggestion",
    messages: {
      missingGetInstance: "Class '{{name}}' caches a static instance but has no static getInstance() accessor.",
    },
  },
  create(context) {
    function checkClass(node) {
      const body = node.body && node.body.body
      if (!body) return
      let hasStaticCache = false
      let hasGetInstance = false
      for (const member of body) {
        if (member.type === "PropertyDefinition" && member.static) {
          const isPrivate = member.key.type === "PrivateIdentifier" || member.accessibility === "private"
          const keyName =
            member.key.type === "PrivateIdentifier"
              ? member.key.name
              : member.key.type === "Identifier"
                ? member.key.name
                : ""
          if (isPrivate && SINGLETON_CACHE_RE.test(keyName)) hasStaticCache = true
        }
        if (member.type === "MethodDefinition" && member.static && member.key.type === "Identifier") {
          if (SINGLETON_STATIC_NAMES.has(member.key.name)) hasGetInstance = true
        }
      }
      if (hasStaticCache && !hasGetInstance) {
        const name = node.id && node.id.type === "Identifier" ? node.id.name : "(anonymous)"
        context.report({ node, messageId: "missingGetInstance", data: { name } })
      }
    }

    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    }
  },
}

/* ─── 12. no-duplicate-exports (error) ─── */

/**
 * Same exported name bound twice in one module: `export const x` plus
 * `export { y as x }`, two `export { … as x }` specifiers, or a declaration
 * colliding with a specifier. `export * from` is skipped (needs module
 * resolution); `export default` is limited to one by the language itself.
 */
const noDuplicateExports = {
  meta: {
    docs: { description: "a module must not bind the same export name twice" },
    schema: [],
    type: "problem",
    messages: {
      duplicateExport: "Export name '{{name}}' is bound more than once in this module.",
    },
  },
  create(context) {
    const seen = new Map() // exported name → first node

    function claim(name, node) {
      if (seen.has(name)) {
        context.report({ node, messageId: "duplicateExport", data: { name } })
      } else {
        seen.set(name, node)
      }
    }

    function claimDeclaration(declaration) {
      if (!declaration) return
      if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === "Identifier") claim(declarator.id.name, declarator.id)
        }
        return
      }
      if (declaration.id && declaration.id.type === "Identifier") claim(declaration.id.name, declaration.id)
    }

    return {
      ExportNamedDeclaration(node) {
        if (node.declaration) claimDeclaration(node.declaration)
        if (node.specifiers) {
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ExportSpecifier") continue
            const exported = specifier.exported
            const name =
              exported.type === "Identifier"
                ? exported.name
                : exported.type === "Literal"
                  ? String(exported.value)
                  : null
            if (name !== null && name !== "default") claim(name, specifier)
          }
        }
      },
    }
  },
}

/* ─── 13. test-requires-timeout-assert (off) ─── */

/**
 * DOCUMENTED PLACEHOLDER (AGENTS.md wires this rule as "off"): eventually
 * every async test will be required to assert a timeout/fake-timer bound so
 * a hung await cannot stall CI. The skeleton (meta + inert create) exists so
 * flipping the severity later is a config-only change.
 */
const testRequiresTimeoutAssert = {
  meta: {
    docs: {
      description:
        "placeholder: async tests should assert a timeout bound (documented as 'off' in AGENTS.md until implemented)",
    },
    schema: [],
    type: "suggestion",
    messages: {
      missingTimeoutAssert: "Async test does not assert a timeout bound.",
    },
  },
  create() {
    return {}
  },
}

/* ─── 14. no-todo-without-issue (warn) ─── */

/**
 * TODO/FIXME/XXX/HACK markers (case-sensitive, whole words) in comments must
 * carry an issue reference: `(#123)` or `ABC-123`. Scans comments only —
 * markers inside string literals are data, not annotations.
 */
const TODO_MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b/
const ISSUE_PARENS_RE = /\(#\d+\)/
const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]*-\d+\b/

const noTodoWithoutIssue = {
  meta: {
    docs: { description: "TODO/FIXME/XXX/HACK comments must reference an issue: (#123) or ABC-123" },
    schema: [],
    type: "suggestion",
    messages: {
      todoWithoutIssue: "'{{marker}}' comment lacks an issue reference — use TODO(#123) or TODO(PROJ-123).",
    },
  },
  create(context) {
    const sourceCode = codeOf(context)
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== "Line" && comment.type !== "Block") continue
          const match = TODO_MARKER_RE.exec(comment.value)
          if (!match) continue
          if (ISSUE_PARENS_RE.test(comment.value) || ISSUE_KEY_RE.test(comment.value)) continue
          context.report({ loc: comment.loc, messageId: "todoWithoutIssue", data: { marker: match[1] } })
        }
      },
    }
  },
}

/* ─── 15. approval-mode-exhaustive (error) ─── */

/**
 * Any switch over approval state must handle its default case, so approval
 * decisions can never fall through silently. Guards the exhaustive switch
 * in approvalFor() (packages/core/src/approval.ts) and every UI switch
 * over PermissionMode/PermissionUIMode.
 */
const APPROVAL_NAME_RE = /approval(?:mode|state|decision)?/i

function looksLikeApprovalName(name) {
  return typeof name === "string" && APPROVAL_NAME_RE.test(name)
}

function discriminantLooksLikeApproval(discriminant) {
  if (discriminant.type === "Identifier") return looksLikeApprovalName(discriminant.name)
  if (discriminant.type === "MemberExpression") {
    if (
      !discriminant.computed &&
      discriminant.property.type === "Identifier" &&
      looksLikeApprovalName(discriminant.property.name)
    )
      return true
    if (discriminant.object.type === "Identifier" && looksLikeApprovalName(discriminant.object.name)) return true
  }
  return false
}

const approvalModeExhaustive = {
  meta: {
    docs: { description: "switch statements over approval mode/state/decision must include a default case" },
    schema: [],
    type: "problem",
    messages: {
      missingDefault:
        "Switch over approval state '{{name}}' has no default case — approval decisions must be exhaustive.",
    },
  },
  create(context) {
    return {
      SwitchStatement(node) {
        if (!discriminantLooksLikeApproval(node.discriminant)) return
        const hasDefault = node.cases.some((switchCase) => switchCase.test === null)
        if (hasDefault) return
        const sourceCode = codeOf(context)
        const name = sourceCode.getText(node.discriminant)
        context.report({ node, messageId: "missingDefault", data: { name } })
      },
    }
  },
}

/* ─── 16. max-file-size (error) ─── */

/**
 * No source file may exceed MAX_FILE_SIZE_LINES. The cap is a ratchet set
 * just above the measured ceiling of the 2026-09-29 splits (index.ts
 * 3117 → barrel + terminal-ui.ts; App.tsx 4134 → App.tsx + app-bootstrap.ts):
 * the largest file in lint scope is App.tsx at 3967 lines, so 4000 locks the
 * split work in. A violation is always fixed by extracting a module — never
 * by raising the cap. Line counting is wc -l semantics (a trailing final
 * newline does not add a line), so editors, wc, and the rule agree.
 * Test files are not exempt: they are code too.
 */
const MAX_FILE_SIZE_LINES = 4000

const maxFileSize = {
  meta: {
    docs: {
      description:
        "source files must not exceed 4000 lines (a violation is fixed by extracting a module, never by raising the cap)",
    },
    schema: [],
    type: "problem",
    messages: {
      fileTooLarge:
        "File has {{lines}} lines (limit {{limit}}) — split it into modules; size violations are fixed by extracting, not by raising the cap.",
    },
  },
  create(context) {
    return {
      Program(node) {
        const lines = String(codeOf(context).text).split(/\r\n|\r|\n/)
        // wc -l: a file ending in a newline has no phantom final line.
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
        if (lines.length > MAX_FILE_SIZE_LINES) {
          context.report({
            node,
            messageId: "fileTooLarge",
            data: { lines: String(lines.length), limit: String(MAX_FILE_SIZE_LINES) },
          })
        }
      },
    }
  },
}

/* ─── plugin surface ─── */

export const rules = {
  "no-ambiguous-boolean": noAmbiguousBoolean,
  "no-cross-package-import": noCrossPackageImport,
  "hook-timeout-required": hookTimeoutRequired,
  "no-sandbox-env-touch": noSandboxEnvTouch,
  "no-any-type": noAnyType,
  "no-console-in-core": noConsoleInCore,
  "require-tool-timeout": requireToolTimeout,
  "no-hardcoded-secrets": noHardcodedSecrets,
  "no-unbounded-exec": noUnboundedExec,
  "no-direct-process-env": noDirectProcessEnv,
  "require-singleton-accessor": requireSingletonAccessor,
  "no-duplicate-exports": noDuplicateExports,
  "test-requires-timeout-assert": testRequiresTimeoutAssert,
  "no-todo-without-issue": noTodoWithoutIssue,
  "approval-mode-exhaustive": approvalModeExhaustive,
  "max-file-size": maxFileSize,
}

export const plugin = {
  name: "nemo",
  version: "0.6.0",
  meta: { name: "nemo", version: "0.6.0" },
  rules,
}

export default plugin
