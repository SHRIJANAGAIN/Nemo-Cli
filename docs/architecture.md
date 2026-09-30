# Architecture

Trayambak is a **TypeScript monorepo**: one root `package.json` compiles the
whole `apps/` + `packages/` + `skt/` tree into `dist/`, and the release build
ships on npm as `@skt-ai-labs/trayambak-cli`.

## Repository layout

| Path                                                                                            | Role                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli/`                                                                                     | **CLI entry**: `src/index.ts` (32 visible subcommands + global flags), `src/commands/*` (config, doctor, run, serve, download, mcp, login, exec, archive, sandbox, flags, …), `src/session/*` (session manager, compaction, checkpoints, fork)                                    |
| `apps/runtime/`                                                                                 | **Agent runtime**: `config.ts` (all config/env handling), `agent/agent-loop.ts` + `agent/agent.ts` (the loop; budget enforcement via `config.budget` → `budget_exhausted`), `tools/` (file edit, command exec, MCP, skills, memory, pentest registry, planning, checkpoint/rewind, web), `prompt/` (system prompt + corpus), `update/` (auto-update), `developer-mode/`, `checkpoints.ts` |
| `apps/trayambak/`                                                                               | Library façade — re-exports `Agent`, `loadConfig`, and the CLI commands for programmatic use                                                                                                                                                                                                                                                                                              |
| `packages/protocol/`                                                                            | Shared types: events, messages, tools, permissions, toolsets                                                                                                                                                                                                                                                                                                                              |
| `packages/provider/`                                                                            | Provider adapters: `llama-cpp`, `nvidia`, `openai`, `xai`, `huggingface`, `anthropic`, `google`, `ollama`, `custom` + `catalog.ts` (defaults, model lists, `verifyProviderKey`)                                                                                                                                                                                                           |
| `packages/core/`                                                                                | Auth (`auth.ts` → `credentials.json`), secrets, context/memory helpers, provider selection, feature flags (`feature_flags.ts`, `trayambak flags`), permission engine (`permissions.ts`, `Tool(glob)` + denial tracker), plan mode (`plan_mode.ts`), subagents (`subagents.ts`, depth guard), token budgets (`token_budget.ts`)                                                            |
| `packages/tui/`                                                                                 | Rendering. **`src/ink-app/` is the interactive UI** (Ink/React: `App.tsx`, pickers, footer, which-key); `src/repl/ink-repl.mjs` is the launcher; `src/index.ts` is the legacy non-Ink renderer                                                                                                                                                                                            |
| `packages/session-backends/`                                                                    | Transcript store (`sessions/<id>/{context,wire}.jsonl`, `state.json`)                                                                                                                                                                                                                                                                                                                     |
| `packages/mcp/`                                                                                 | MCP **client** (stdio + HTTP/SSE transports, OAuth 2.0 + PKCE)                                                                                                                                                                                                                                                                                                                            |
| `packages/mcp-server/`                                                                          | Minimal MCP **server** over stdio (`trayambak mcp-server`)                                                                                                                                                                                                                                                                                                                                |
| `packages/acp/`                                                                                 | ACP server over stdio (`trayambak acp`)                                                                                                                                                                                                                                                                                                                                                   |
| `packages/server/`                                                                              | HTTP agent API (`trayambak web`)                                                                                                                                                                                                                                                                                                                                                          |
| `packages/sdk/`                                                                                 | TypeScript SDK (`TrayambakClient.startThread/resumeThread/exec`)                                                                                                                                                                                                                                                                                                                          |
| `packages/sandbox/`                                                                             | In-process sandbox policy engine + honest backend detection (seatbelt/bwrap probed, else fallback; `policy-only` enforcement) and the exec rule engine                                                                                                                                                                                                                                    |
| `packages/coding-agent`, `client`, `evals`, `function`, `harness`, `schema`, `telemetry`, `cli` | Supporting packages (coding-agent abstractions, client, eval harness, function calling, test harness, JSON schema helpers, telemetry sinks, an additional command registry)                                                                                                                                                                                                               |
| `skt/`                                                                                          | Numbered internal subsystems (`0-points` … `14-hooks`): mistake memory (`1-errors`), eval loop (`5-eval`), user instructions (`3-user`), memory (`4-mem`), control/repetition (`12-control`), healing/rollback (`13-healing`), hooks (`14-hooks`); `context.ts` assembles their context block                                                                                             |
| `assets/agents/`                                                                                | Bundled specialist subagent personas (`.md` definitions) used by `/agent`                                                                                                                                                                                                                                                                                                                 |
| `commands/`                                                                                     | Prompt-file slash commands — drop `.md` files in `./commands/`, `./.trayambak/commands/`, or `~/.trayambak/commands/`                                                                                                                                                                                                                                                                     |
| `skills/`, `rules/`, `agent-prompts/`                                                           | Skill markdown (YAML front-matter), per-language rules, extra prompts                                                                                                                                                                                                                                                                                                                     |
| `bin/`                                                                                          | `trayambak.cmd` / `skt.cmd` Windows shims + bundled llama.cpp binaries                                                                                                                                                                                                                                                                                                                    |
| `scripts/`                                                                                      | `make-publish.mjs` (release build), `install-global.js`, smoke scripts                                                                                                                                                                                                                                                                                                                    |
| `config.schema.json`                                                                            | JSON Schema for the config file                                                                                                                                                                                                                                                                                                                                                           |
| `docs/`                                                                                         | This documentation                                                                                                                                                                                                                                                                                                                                                                        |

## Runtime data flow

```
trayambak  (bin shim → dist/apps/cli/src/index.js)
   │  parseFlags()  →  loadConfig()            apps/runtime/src/config.ts
   │                    (defaults < file < TRAYAMBAK_* env < flags)
   │
   ├─ subcommands (config/doctor/exec/web/acp/mcp/…) run directly
   │
   └─ run/chat: spawn packages/tui/src/repl/ink-repl.mjs  (ESM child)
         env: TRAYAMBAK_CONFIG_JSON, TRAYAMBAK_PROMPT, TRAYAMBAK_MODEL, …
              │
              └─ ink-app/App.tsx  ── Agent (apps/runtime/src/agent)
                                       │  tool loop: bash/read/edit/grep/…,
                                       │  mcp__* tools, skills, planning
                                       ├─ packages/provider (wire formats)
                                       └─ events → TUI + transcript
                                                   (packages/session-backends)
```

The REPL is the _only_ interactive UI; the CLI hands it the resolved config
via `TRAYAMBAK_CONFIG_JSON` so the child never sees `undefined` fields.

## Build pipeline

Three steps, all wired into `npm run build`:

| Step                | Command                                                          | Output                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Main compile     | `tsc -p tsconfig.json --noEmitOnError`                           | `dist/` — CommonJS, ES2022, `jsx: react`. Covers `apps/**`, most of `packages/**`, `skt/**`. **Excludes** `packages/tui/src/ink-app/**`                                                                                                                                                 |
| 2. Ink compile      | `npm run build:ink` → `tsc -p tsconfig.ink.json --noEmitOnError` | `dist/packages/tui/src/ink-app-esm/` — NodeNext **ESM**, `jsx: react-jsx`. Only `ink-app/**` + `ui/theme.ts`                                                                                                                                                                            |
| 3. Assets + flatten | inline `node -e` step, then `require('./fix-esm-imports.js')`    | copies `EVALR.MD`, `mistakes.json`, `evals.json`, `EVALS.MD`, `ink-repl.mjs`, `logo_ansi.txt`, `prompt/corpus.txt` into `dist/`, flattens the ESM tree to the output root, drops the nested `packages/ apps/ skt/ ink-app/` dirs, and writes `{ "type": "module" }` into the ESM folder |

Supporting scripts (root `package.json`):

| Script                            | What it does                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`               | `tsc -p tsconfig.check.json` — noEmit + incremental twin of the main config                                                                                                                                                                                                                     |
| `npm run typecheck:ink`           | `tsc -p tsconfig.ink-check.json` — same for the Ink app                                                                                                                                                                                                                                         |
| `npm run build:loose`             | Emit-only build (`--noCheck`) for a fast local smoke run                                                                                                                                                                                                                                        |
| `npm run lint`                    | `eslint apps packages skt` (flat config in `eslint.config.mjs`; no `--ext`)                                                                                                                                                                    |
| `npm run format` / `format:check` | Prettier                                                                                                                                                                                                                                                                                        |
| `npm test`                        | `vitest run` (`vitest.config.ts`); coverage: `npx vitest run --coverage` (`@vitest/coverage-v8`)                                                                                                                                                                                                |
| `npm run sbom`                    | CycloneDX SBOM → `sbom.cyclonedx.json`                                                                                                                                                                                                                                                          |
| `npm run publish:build`           | `npm run build` + `scripts/make-publish.mjs` — copies to `publish/`, obfuscates JS (skip with `TRAYAMBAK_SKIP_OBFUSCATION=1` or `--skip-obfuscation`), adds the `node` shebang, writes `publish/package.json` (`@skt-ai-labs/trayambak-cli`, `files: ["dist","Img"]`, bins `trayambak` + `skt`) |
| `npm run publish:npm`             | publish build + `npm publish ./publish --access public --provenance`                                                                                                                                                                                                                            |

Two tsconfigs exist on purpose: the emitting one avoids `incremental` (a
deleted `dist/` file would otherwise never be regenerated), and the check-only
twin keeps `npm run typecheck` fast without touching `dist/`.

## CI (`.github/workflows/ci.yml`)

| Job                      | Commands                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck + version sync | `npm run typecheck`, `npm run typecheck:ink`, `npm run sync-version` + `git diff --exit-code` on `apps/cli/src/version.ts`                                        |
| Lint + format            | `npm run lint`, `npm run format:check`                                                                                                                            |
| Tests                    | `npm run test` on Node **18, 20, 22** (Ubuntu) + Node **20** on **Windows** and **macOS** (5 legs)                                               |
| Coverage thresholds      | `npm run test:coverage` (uploads `coverage/` artifact)                                                                                                            |
| Build                    | `npm run build` + `--version` smoke on Ubuntu **and Windows**; Windows also smoke-tests the `bin\trayambak.cmd` / `bin\skt.cmd` shims (stale-dist detection path) |
| Publish tarball audit    | `TRAYAMBAK_SKIP_OBFUSCATION=1 npm run publish:build` then `npm run verify:pack`                                                                                   |
| Audit + SBOM (blocking)  | `npm audit --omit=dev --audit-level=high`, `npm run sbom` (SBOM uploaded)                                                                                         |
| Schema + docs            | `config.schema.json` / `docs/README.md` / `LICENSE` exist, the schema parses, and `npm run check:links` proves every internal doc link + anchor resolves          |
| Codespell                | spell-check over the repo                                                                                                                                         |

`.github/workflows/release.yml` (tags `v*`) additionally gates on
tag ↔ `package.json` version equality, blocks on the SBOM, verifies the
tarball with `verify:pack` before `npm publish --provenance`, and creates
a GitHub Release with generated notes.

## Design notes

- **Proprietary license, all source headers**: every `.ts` file starts with
  the SKT AI LABS copyright + Trayambak CLI Proprietary License header (see
  `LICENSE`).
- **Config is validated, never fatal**: bad MCP servers, hooks, model caches,
  and keys are sanitised at load (`sanitizeConfig`, `cleanMcpServers`,
  `cleanToolHooks`, `cleanApiKey`) instead of crashing later.
- **Transcripts are append-only** and written best-effort — a disk error must
  never break a turn.
- **Headless mirrors the REPL**: `exec`, `web`, `acp`, and the SDK all drive
  the same `Agent` from `apps/runtime`, so behaviour matches the interactive
  session.

## Related

- [Getting started](getting-started.md) — user-facing commands and config.
- [MCP](mcp.md) · [ACP](acp.md) · [Web](web.md) — integration surfaces.
- [Troubleshooting](troubleshooting.md) — build and runtime diagnosis.
