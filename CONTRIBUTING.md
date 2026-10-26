# Contributing to nemo

nemo is developed and maintained by Shrijan and
licensed under the **Apache License 2.0** — see
[LICENSE](LICENSE). Contributions are accepted under the same licence: by
submitting a patch you agree it is distributed under the Apache License 2.0.

## Getting started

```
npm install
npm run build
node dist/apps/cli/src/index.js --help
```

`npm run build` compiles the main tree (`tsc -p tsconfig.json`), the Ink UI
(`tsc -p tsconfig.ink.json`), copies runtime assets, and runs
`fix-esm-imports.js`. The compiled CLI entry is **`dist/apps/cli/src/index.js`**
— that is also what the `nemo` / `nemo` bins point at. If you have the
shims installed (`node scripts/install-global.js`), plain `nemo` works
too.

## Checks to run before a PR

```
npm test                # vitest run
npm run typecheck       # tsc -p tsconfig.check.json (noEmit)
npm run typecheck:ink   # Ink UI typecheck
npm run lint            # eslint apps packages nemo
npm run format:check    # prettier
```

Coverage: `npx vitest run --coverage` (via `@vitest/coverage-v8`).

## Project structure

The codebase is a single-package TypeScript monorepo: one root `package.json`
compiles `apps/` + `packages/` + `nemo/` into `dist/`:

- `apps/cli` — CLI entry, subcommands, flags.
- `apps/runtime` — config loader, agent loop, tools, prompts, auto-update.
- `packages/*` — protocol, provider adapters, TUI (Ink), MCP, ACP, server,
  SDK, sandbox, session backends, and friends.
- `nemo/` — numbered internal subsystems (mistake memory, evals, hooks, …).

See `AGENTS.md` for the conventions and layout notes, and
[docs/architecture.md](docs/architecture.md) for the full map.

## Pull requests

- Keep changes focused and include a short description of intent.
- Ensure `npm run build` and `npm run typecheck` pass before submitting.
- All new source files must carry the Apache-2.0 header
  (see the header on any existing `.ts` file).
- Do not commit lockfile or dependency changes unless explicitly requested.
