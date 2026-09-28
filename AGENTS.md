# trayambak - Development Rules

## Branding

- All source files must begin with the SKT AI LABS copyright header, and the
  project is licensed under the **Apache License 2.0** (see
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
  MCP client/server, `packages/acp`, `packages/server`, `packages/sdk`,
  `packages/sandbox`.
- Additional capabilities live in their own `packages/*` (client, coding-agent,
  telemetry, evals, schema, function, harness).
- `skt/` numbered internal subsystems (mistake memory, evals, memory, control,
  healing, hooks).
- `assets/agents/*`: bundled specialist subagent personas for architecture,
  language-specific code review, build resolution, security auditing, and
  refactoring.
- Parallel multi-agent workflows: `trayambak__ParallelReview` (multi-dimension parallel review with evidence deduplication & adversarial verification) and `trayambak__ParallelExecute` (collaborative parallel execution).

## Commands

- `npm run build` compiles the project with `tsc` (main tree + Ink UI +
  assets + `fix-esm-imports.js`).
- `npm run typecheck` type-checks without emitting (`tsconfig.check.json`).
- `npx vitest run` (or `npm test`) runs all tests.
- Run the CLI from the compiled output: `node dist/apps/cli/src/index.js`
  (e.g. `node dist/apps/cli/src/index.js --help`). With the shims installed
  (`node scripts/install-global.js`), `trayambak` / `skt` work directly.

## Before Committing

- Run `npm run build` and `npm run typecheck`; fix every error and warning.
- Run `npm run lint` and `npm test` too — CI runs both.
- Do not commit lockfile or dependency changes unless explicitly requested.
