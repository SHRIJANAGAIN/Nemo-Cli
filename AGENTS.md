# trayambak - Development Rules

## Branding

- All source files must begin with the SKT AI LABS copyright header, and the
  project is licensed under the **Trayambak CLI Proprietary License** (see
  `LICENSE`).
- Refer to the project as **trayambak**; do not reuse names or strings from third-party agent projects.

## Code Style

- TypeScript with strict mode. Avoid `any` unless strictly necessary.
- Use explicit class fields; no parameter properties, `enum`, or `namespace`.
- Imports are top-level only; no inline `import()`.
- Keep functions small and single-purpose.

## Layout

- `apps/cli` is the CLI entry (subcommands, flags, session commands);
  `apps/runtime` holds the config loader, agent loop, tools, prompts, and
  auto-update; `apps/trayambak` re-exports the runtime as a library.
- `packages/protocol` shared types, `packages/provider` provider adapters
  (llama.cpp/NVIDIA/NVIDIA NIM/OpenAI/Anthropic/Google/xAI/Hugging Face/Ollama/custom),
  `packages/tui` rendering (the Ink UI lives in `packages/tui/src/ink-app`),
  `packages/session-backends` transcripts, `packages/mcp` + `packages/mcp-server`
  MCP client/server, `packages/acp`, `packages/server`.
- Additional capabilities live in their own `packages/*`:
  `approval` (auto-approval policy), `client` (HTTP client for the local
  server), `function` (tool registry), `schema` (config validation),
  `sdk` (TypeScript SDK), `coding-agent` (high-level coding task
  orchestrator), `harness` (runtime plugin/facts harness),
  `checkpoints`, `mcp-server`, `modes`.
- `packages/core` holds the shared primitives: `approval.ts` (the single
  tool-approval decision point), `hook_runtime.ts`, `rollout_budget.ts`,
  `token_budget.ts`, `plan_mode.ts`, `process.ts` (output caps, process-group
  kill, cancellation), `secrets.ts` (redaction + secure dirs),
  `state_db.ts` (state + hash-chained `audit_log`), `auth.ts`,
  `subagents.ts`, `analytics.ts`, `env_filter.ts`, `feature_flags.ts`,
  `session_store.ts`, plus `context/`, `cron/`, `curator/`, `memory/`,
  `providers/`, `toolsets/` subdirectories.
  **The agent loop itself is `apps/runtime/src/agent/agent-loop.ts`, not
  `packages/core`.**
- `packages/sandbox` holds the OS-level sandbox: `gate.ts` is the single
  decision point for whether a run is `policy-only` or `os-sandbox`,
  `spawn.ts` implements the seatbelt/bubblewrap spawners, and
  `execpolicy` implements the deny-first command policy.
- `skt/` numbered internal subsystems (mistake memory, evals, memory, control,
  healing, hooks).
- `assets/agents/*`: bundled specialist subagent personas for architecture,
  language-specific code review, build resolution, security auditing, and
  refactoring.
- Parallel multi-agent workflows: `trayambak__ParallelReview` (multi-dimension
  parallel review with evidence deduplication & adversarial verification) and
  `trayambak__ParallelExecute` (collaborative parallel execution).

## Security Model

- **One decision point.** `approvalFor()` in `packages/core/src/approval.ts`
  is the only place a tool call is approved. Its switch is exhaustive and its
  `default` returns `ask`, so an unknown future action can never silently
  allow. The `approval-mode-exhaustive` lint rule enforces the `default`.
- **Destructive actions are gated twice.** `FORCE_ASK_RULES`
  (`packages/protocol/src/permission-rules.ts`) pattern-matches destructive
  commands. `IRREVERSIBLE_FORCE_ASK_REASONS` narrows that set to the actions
  whose damage cannot be undone (deletion, data/infra destruction, evidence
  erasure, unreviewed remote code execution); those still ask under
  `auto-approve`. Recoverable or routine operations only ask in the default
  `ask` mode, so auto-approve does not become a prompt wall.
- **Enforcement is honest by construction.** `packages/sandbox/src/gate.ts`
  reports `os-sandbox` only when a real isolator backs the backend, and
  Windows and unknown platforms stay `policy-only` because no OS isolator
  exists there. A handle never claims isolation it does not have.
  `FEATURE_SANDBOXSPAWN=0` forces the policy-only path.
- **Audit is tamper-evident.** `audit_log` rows are hash-chained
  (`sha256(prev_hash + canonicalJSON(row))`) in both state backends, with
  `prev_hash` kept inside the canonical body so reordering breaks linkage.
  `verifyChain()` reports which link broke and why.
- **Secrets.** `secrets.ts` centralises redaction before hooks, audit,
  analytics, and telemetry, and writes credentials `0600` via an atomic
  temp-file rename. `logout()` clears without unlinking, so it never becomes
  a path-existence oracle.

## Commands

- `npm run build` compiles the project with `tsc` (main tree + Ink UI +
  assets + `fix-esm-imports.js`).
- `npm run typecheck` type-checks without emit (`tsconfig.check.json`).
- `npx vitest run` (or `npm test`) runs all tests.
- Run the CLI from the compiled output: `node dist/apps/cli/src/index.js`
  (e.g. `node dist/apps/cli/src/index.js --help`). With the shims installed
  (`node scripts/install-global.js`), `trayambak` / `skt` work directly.

## Testing

- **Harness**: tests use real `Agent` construction, fake HTTP provider stubs
  (local `http.createServer`), in-memory transcript backends, and
  deterministic temp directories. There is no `TestTrayambakBuilder`; use
  `packages/provider/src/providers.test.ts` patterns (fake server + stub
  responses) for model-free tests.
- **Coverage**: measured from `npm run test:coverage`. Current ratchets
  (floors, defined in `vitest.config.ts`; must only rise):
  - repo floor: **55% statements / 73% branches / 63% functions / 55% lines**
  - `packages/core/src/**`: **79% statements / 85% branches / 83% functions / 79% lines**
- All new code must land with tests or CI goes red.
- Test files must live alongside source: `foo.ts` → `foo.test.ts`.
- Every new module must have a `.test.ts` file.

## Before Committing

- Run `npm run build` and `npm run typecheck`; fix every error and warning.
- Run `npm run lint` and `npm test` too — CI runs both.
- Do not commit lockfile or dependency changes unless explicitly requested.
- Verify every new module is imported somewhere in the tree before shipping
  (grep for its package path from `apps/` and `packages/`).
