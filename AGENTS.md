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

## Evidence Discipline — "No Evidence = No Claim"

This section is additive and outranks any habit of the opposite kind. A claim
without evidence is a defect, not a shortcut.

- **Never fabricate.** Not test results, not file contents, not command
  output, not a successful completion, not a file that "should" exist. If a
  command was not run, it did not pass.
- **Never assume.** Repository structure, APIs, dependencies, runtime
  behaviour, test outcomes and documentation are all inspected, never
  inferred from plausibility. Every implementation decision must be traceable
  to a file you read, a tool output you saw, or documentation you verified.
- **If validation cannot be performed, say so explicitly.** "Not verified
  because X is broken" is a valid report. Silence is not.
- **Never say "works" without verification.** This one rule eliminates most
  coding-agent hallucination on its own.

### The loop

`Observe → Search → Understand → Plan → Edit → Run → Inspect output → Test →
Review diff → Report evidence`

Never: `Prompt → Guess → Generate 500 lines → "Done."`

### Inspect before editing

- Read the relevant files, imports, configs, types, and the existing patterns
  around the change **before** writing a line of it.
- **Never invent APIs, files, functions, packages or endpoints.** Verify the
  symbol exists at the path you are about to import from. A grep for the
  import path is the cheapest possible check and it is mandatory.
- **Search aggressively** — symbol search, reference/call-site inspection,
  dependency search. A new symbol with zero call sites is a bug you shipped.
- **Read the docs/source when uncertain**, especially for unfamiliar
  libraries, SDKs, framework versions, and APIs. Guessing an API shape is how
  a 500-line change becomes a 0-line working one.

### Verify errors from real output

- Terminal, compiler, linter and test output are ground truth. Diagnose the
  actual first error, not the error you expect.
- Reproduce a bug **before** fixing it whenever practical: establish the
  failure, apply the fix, then demonstrate that it disappeared. A fix with no
  reproduction and no disappearing failure is a guess wearing a commit.

### Small changes, re-checked

- Patch incrementally and re-run the most relevant validation after each
  meaningful change. Do not batch five edits then run tests once.
- Keep an **evidence trail**: for every important claim, know which file,
  command output, test, or doc line proves it. State the evidence inline
  ("`verify:pack` PASS", "324 files / 3752 passed / 0 failed"), not a vague
  "tests pass".
- **Distinguish fact from assumption** in your own report. Mark the uncertain
  parts as uncertain.

### Self-review the final diff

Before reporting done, read the diff and check for: unintended changes,
broken imports, type mismatches, security regressions, missing edge cases,
and anything that silently contradicts an existing rule. `git diff` is the
cheapest review that exists.

### When another session shares the tree

This repo is edited concurrently. One writer per file.

- If `tsc`/tests fail in files you never touched, **do not "fix" them** —
  report the path and the error verbatim and attribute them to the other
  writer. Editing them causes lost work.
- Re-run a flaky test **individually** before calling it a real failure; load
  causes Windows timeouts (`state_db`, `git_exec`, `sandbox/spawn`,
  `bash`, `command-dispatch`) that pass alone.
- Never revert, and never delete a file you did not create.

### Human conduct

- **Never focus on, infer, or comment about a person's gender, identity, or
  any protected characteristic.** Treat every user as a user. Do the work.
- Stay factual and even-handed: no flattery, no superlatives, no invented
  urgency, and no claims about a human's intent beyond what they wrote.
- Report bad news plainly and early (a broken build, a blocked publish, a
  conflict with another writer). Burying it to sound agreeable is a defect.

### Reporting

- **Every message ends with a summary of what changed**, and every non-trivial
  change also lands a written summary in the repo (see `README.md` /
  `CHANGELOG.md`).
- The summary states: what changed, which files, which validation commands
  were run, and their **real output**. Anything unverified is listed as
  unverified.
- Never claim a publish, deploy, commit, or push happened unless the command
  ran and its output says so.
