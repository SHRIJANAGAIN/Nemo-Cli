# Changelog

All notable changes to trayambak are documented here. The format is based on keeping an
`Unreleased` section; released sections are immutable.

## [0.6.0]

### Changed — Apache-2.0 relicense (owner-authorized) + WIP stabilization
- `LICENSE`: Proprietary v1.0 → Apache License 2.0 (© 2026 SKT AI LABS PRIVATE LIMITED); `package.json` license `Apache-2.0`; 400 source headers + `AGENTS.md`/`docs/README.md`/vscode-extension manifest updated.
- Fixed concurrent-author WIP so the tree is green again: sandbox `spawn.ts` (seatbelt names, pid guards, signal casts), `core/process.ts` (no require, typed signals/streams), `core/env_filter.ts` (ProcessEnv input), `core/state_db.ts` (JSON-file backend — no native `better-sqlite3` dep; same API), `core/hook_runtime.ts` (`additionalContext`), `core/agent_registry.ts` (`uuid()`), `command-exec/bash.ts` (no `ctx.emit`, unknown-cast permissions), `prompt/auto-title.test.ts` (unknown-shape helper), `tools/text/*.test.ts` (protocol import), `tui/ui/footer*.ts` (Theme import, indicator fn), sandbox `index.ts` (dedup re-exports).

## [0.5.0]

### Changed — production hardening (7-axis scorecard push to 10)

- **Dead code removal**: deleted orphaned `apps/cli/src/agent/` (58 files — enforcement actually lives in agent-loop, protocol engine and runtime bash), plus fake/dead commands (`stats`, `daemon`, `profile`, `roll-call`, `cloud`, `session-import`, `console`, `integration/cloud`, `integration/config-validation`). Wired previously dead `resume` and `export` as real subcommands; `export` honors `--format json|text|markdown`.
- **Release correctness**: version single-sourced from `package.json` via `scripts/sync-version.mjs` (stamps `apps/cli/src/version.ts`; CI fails on drift). Every build runs `clean-dist.mjs` so stale dist is structurally impossible; `bin/*.cmd` shims self-heal via `check-dist.mjs`. New `verify:pack` gate asserts tarball contents (entry+shebang, no tests/maps/journals, ≥50 personas, secret scan).
- **Command registry**: new `command-registry.ts` as single source for root help, `<cmd> --help` / `help <cmd>`, strict flag validation (aliases canonicalized, unknown flags exit 2) and shell completion (bash/zsh/fish/powershell); exit codes standardized (0 ok / 1 error / 2 usage).
- **Observability**: structured JSON logger with file sink + rotation (`TRAYAMBAK_LOG`, `TRAYAMBAK_LOG_LEVEL`, `TRAYAMBAK_LOG_DIR`); unknown commands and fatals are logged, not swallowed.
- **Sandbox honesty**: `detectBackend()` now probes for real integrations (`/usr/bin/sandbox-exec`, `/usr/bin/bwrap`) and returns `fallback` otherwise — it no longer claims unwired OS backends (landlock/restricted-token are documented as reserved). Every check reports `enforcement: "policy-only"`; `sandbox`/`execpolicy` CLI output states that no OS sandbox is spawned. `DEFAULT_EXEC_RULES` strengthened (mkfs/dd/reg delete/vssadmin/pipe-to-shell, ordered first-match).
- **Config**: `--config <file>` / `TRAYAMBAK_CONFIG` now actually honored by `configPath()` (was declared in `--help` but unused); applied uniformly to every flag-parsing command.
- **Mistake journal**: `skt/1-errors/mistakes.json` moved to user state dir (`~/.trayambak/skt/1-errors`, `TRAYAMBAK_STATE_DIR` override) with one-time legacy migration — never shipped in the tarball.
- **CI/CD**: `ceo-audit.yml` deleted (depended on unavailable external repos/secrets, could never pass); `ci.yml` gained blocking `npm audit --omit=dev --audit-level=high`, SBOM artifact, coverage-threshold job, version-sync gate, Windows test/build legs with `bin\*.cmd` shim smoke tests, and a `verify:pack` job; `release.yml` gained tag↔version gates, blocking SBOM, pre-publish tarball verification and auto GitHub Release notes.
- **Repo hygiene**: 2,029 files / 12.9 MB removed (stale `.bak`, compiled artifacts, legacy reference TUI); `.gitignore` covers coverage/, journals, bin binaries, backups; `bin/README.md` documents llama.cpp binary provenance.
- **Lint + format**: repo-wide Prettier pass (579 files) and all ESLint errors fixed (was 16: dead files `file-icon.ts`/`update_prompt*.js` deleted, `require()` → ESM imports, dead render-cache vars removed, `@ts-ignore` dropped once proven unnecessary); `npm run lint` exits 0 and `format:check` passes.
- **Help rendering**: long usage lines no longer glue onto their summary (`trayambak config …[value]Manage configuration values` bug), with a regression test over every visible command row.
- **Docs integrity**: new `npm run check:links` gate (`scripts/check-docs-links.mjs`) validates every internal doc link and `#anchor` slug; wired into CI's schema job.
- **Release path proven**: obfuscated `publish:build` + `verify:pack` verified end-to-end (332 files obfuscated; pack gate's version check correctly falls back to `publish/package.json` when the literal is string-array-inlined); obfuscated artifact smoke-tested (`--version`, `help <cmd>`, unknown-command exit 2).

### Added — CLI-only round 2 (no provider changes)

- `packages/modes/src/index.ts` + `modes` cmd: 5 built-ins + `.roomodes` loader; `docs/modes.md`.
- `packages/approval/src/index.ts`: prefix allow/deny + protected files; `packages/core/src/validate.ts` required-args guard; `docs/approval.md`.
- `packages/mcp-server/src/index.ts`: real `read_file`/`bash` exec (bounded); project `.trayambak/mcp.json` scope merged in `config.ts`.
- `packages/checkpoints/src/index.ts` + `checkpoint` cmd: file-snapshot create/list.
- `packages/core/src/i18n.ts` (en/hi) + `PRIVACY.md`; `scripts/e2e.mjs` + `test:e2e` + CI e2e gate.
- Providers unchanged (10 BYOK) per request.
- `apps/cli/src/commands/exec.ts`: headless `exec` JSON events + `review`; `archive.ts`: `archive/unarchive/delete`.
- `packages/server/src/daemon.ts`: pid lifecycle; `config.schema.json`; `docs/README.md` full guides.
- `ci.yml`: +schema/docs +codespell jobs; version `0.5.0`.

## [0.4.0]

### Added — parity push to 10

- `packages/session-backends/src/transcript.ts`: per-session `sessions/<uuid>/{context.jsonl,wire.jsonl,state.json}`, empty-skip, legacy migrate, newest-first list.
- `packages/acp/src/index.ts`: ACP stdio JSON-RPC (`initialize/new_session/load_session/list_sessions/set_model/prompt/cancel`); CLI `trayambak acp`.
- `packages/server/src/index.ts`: `/api/sessions`, `/openapi.json`, CORS, `Bearer` token (`TRAYAMBAK_WEB_TOKEN`); CLI `trayambak web --port 8787`.
- `apps/cli/src/index.ts` + `flags.ts`: wired dead `serve`/`download`, new `acp`/`web`, `--key=value` + `--no-*` parsing, `--config/--port/--host` flags.
- `packages/core/src/secrets.ts`: `withFileLock` + `redactSecrets` + `secureDir` (0700).
- `.github/workflows/release.yml`: multi-OS build + SBOM + npm `--provenance` publish; `docs/README.md`; version `0.4.0`.

## [Unreleased]

### Fixed — production-readiness hardening

- `apps/cli/src/session/session-manager.ts`: UUID ids (no `Date.now()` collisions), disk persistence (`~/.trayambak/sessions.json`, atomic 0600 writes), `fork()` honors requested name, `update()` preserves `id`/`createdAt`.
- `apps/runtime/src/config.ts` + `packages/session-backends/src/index.ts`: atomic writes with `0600` perms for `config.json` and transcripts.
- `package.json`: strict `build`/`build:ink` (fail on type errors, `build:loose` keeps old behavior), new `test`/`lint`/`format`/`sbom` scripts, `publish:npm --provenance`, `publish:build:debug` skip-obfuscation flag.
- CI: new `.github/workflows/ci.yml` (typecheck, eslint, prettier, vitest matrix 18/20/22, build smoke, npm audit + SBOM).
- `SECURITY.md`: supported versions, 3-day ack / 14-day fix SLA, scope, secret-handling, provenance/SBOM notes.
- `Dockerfile` + `.dockerignore`: Linux prod image; `eslint.config.mjs` + `.prettierrc.json` added.
- `scripts/make-publish.mjs`: `TRAYAMBAK_SKIP_OBFUSCATION=1` for debuggable builds.

### Added

- `packages/protocol`: shared message, tool, and event types.
- `packages/provider`: llama.cpp OpenAI-compatible streaming client with native and text-fallback tool calling.
- `packages/core`: agent loop, tools (bash, read/write/edit file, list_dir, grep, glob), session, prompts.
- `packages/tui`: terminal rendering and input.
- `packages/cli`: `run`, `serve`, `config`, `models` commands.
- `packages/server` / `packages/client`: local HTTP surface and client SDK.
- `packages/coding-agent`: high-level task orchestrator.
- `packages/session-backends`, `packages/telemetry`, `packages/schema`, `packages/function`, `packages/evals`: supporting modules.
