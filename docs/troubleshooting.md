# Troubleshooting

## Broken symbols (`?` instead of dots/marks)

The TUI uses ●○◌✓✗★❯█⚠ by default, with user rows marked `❯` and a
braille thinking spinner. If your console shows `?` tofu instead, force
the ASCII set (`* o - v x ! > _` + pipe spinner):

```
set TRAYAMBAK_GLYPHS=ascii    # force ASCII
set TRAYAMBAK_GLYPHS=unicode  # force Unicode (Windows Terminal, VS Code)
```

For a permanent fix on old conhost: switch the console font to Cascadia
Mono / DejaVu Sans Mono, or use Windows Terminal.

Start with the built-in diagnostics:

```sh
trayambak doctor   # environment checks; exits 1 when any check fails
trayambak info     # version, node, platform, cwd, baseUrl, model, shell, maxTurns, tools
```

`doctor` checks (in order): **Node ≥ 18**, **config file** (created or
defaults), **GGUF model** (if `modelPath` is set), **llama.cpp server
binary**, **server reachable** (`GET <baseUrl>/v1/models`, 3s timeout), and
**home directory**. Failures print their detail under `Failed checks:`.

## Provider / auth problems

### `401` on every request

The built-in hints (`packages/provider/src/catalog.ts`):

| Provider     | Hint                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------- |
| NVIDIA / NIM | 401 = key rejected: use a **bare** `nvapi-…` key (no `NVAPI_KEY ` prefix) from build.nvidia.com |
| OpenAI       | 401 = key rejected or no billing on the account                                                 |
| Anthropic    | 401 = key rejected: check console.anthropic.com API keys                                        |
| Google       | 400/401 = bad key, or the Generative Language API is disabled for the project                   |
| xAI          | 401 = key rejected: check console.x.ai API keys                                                 |

Usual causes, in order:

1. **A prefixed key.** `NVAPI_KEY nvapi-…`, `Bearer sk-…`, or `KEY=…` pasted
   verbatim — `cleanApiKey()` strips these at load, but an old clean-saved key
   may still be the wrong one. Re-paste it with `/provider`.
2. **Env overriding your file.** `TRAYAMBAK_API_KEY` beats `config.json`.
   Check with `trayambak config get apiKey` and `trayambak login status`.
3. **A stray config entry.** Legacy flag-style keys (`--apiKey`, `--baseUrl`)
   used to hide the real value — current versions map them to the canonical
   keys automatically; delete any you still see.

### Model picker shows only the static fallback list

Live `/v1/models` failed or timed out (10s) — the picker then falls back to
the per-provider static list so it is never blank. Fix the network/key and
re-open `/models`; successful lists are cached in `config.modelCache`.

### Ollama: "connection failed"

`ollama unreachable = is \`ollama serve\` running?`— default base URL is`http://localhost:11434`, no key needed. Confirm with
`trayambak config get baseUrl` and start Ollama.

## Local model (llama.cpp) problems

- **Binary not found** — `doctor` says
  `not found - set TRAYAMBAK_LLAMACPP_BIN or run \`trayambak serve\` to auto-download`.
Either let `trayambak serve`download it, or point`TRAYAMBAK_LLAMACPP_BIN`at a prebuilt`llama-server`/`server.exe`.
- **No model** — `trayambak download <org/model> [file.gguf]` fetches a GGUF
  and stores it as `modelPath`; verify with `trayambak config get modelPath`.
- **GPU offload seems ignored** — a CPU-only llama.cpp build silently ignores
  `--n-gpu-layers`. `serve` probes `nvidia-smi`/`rocminfo` and inspects the
  binary for CUDA/Vulkan/D3D libraries; if the build has none, run CPU-only or
  install a GPU build. Server output is in `~/.trayambak/logs/llama-server.log`.
- **Tuning knobs** — `TRAYAMBAK_CTX_SIZE` (default 16384), `TRAYAMBAK_BATCH_SIZE`
  (256), `TRAYAMBAK_UBATCH_SIZE` (128), `TRAYAMBAK_GPU_LAYERS`.

## Configuration problems

### My settings disappeared

`saveConfig()` is merge-based and defensive:

- The previous good file is always rotated to `config.json.bak`.
- An unparseable file is copied aside as `config.json.corrupt-<timestamp>`
  before continuing — restore by copying it back.
- Torn concurrent writes no longer wipe unrelated keys (legacy `--apiKey`-style
  keys are mapped onto canonical names at load).

If values seem ignored, remember precedence: **defaults < config file <
`TRAYAMBAK_*` env < CLI flags**. An env var quietly wins over the file.

### The wrong config file is being used

The loader prefers `./.trayambak/config.json` whenever a `.trayambak/`
directory exists **in the current working directory**, otherwise
`~/.trayambak/config.json`. A stray project-local `.trayambak/` overrides your
home config — check `trayambak doctor`'s `Config file:` line.

### A command I expected is "Unknown command"

`trayambak` prints `Unknown command: <x>` plus help and exits `2` (the usage
code — `EXIT_USAGE` in `apps/cli/src/command-registry.ts`). Notably
there is **no `trayambak models`** — model listing is the `/models` slash
command inside the session (or `/provider`). `trayambak help` lists every
subcommand.

## Web server problems

- **`401 {"error":"unauthorized"}`** — a token is configured (`--token` or
  `TRAYAMBAK_WEB_TOKEN`); send `Authorization: Bearer <token>`. `/health` is
  the only route that skips auth.
- **No token, worried about exposure** — without a token the server has **no
  authentication**; keep `--host 127.0.0.1` (the default).
- **Port in use** — pick another with `trayambak web --port 9000`.

## MCP problems

- **`timeout on 'initialize'`** — the default per-call timeout is 60s
  (`spec.timeoutMs`, clamped 1 000–600 000 ms). Slow stdio servers should raise
  it in `mcpServers.<name>.timeoutMs`.
- **`OAuth is disabled for '<name>' (oauth: false)`** — set `"oauth": true`
  (or an object) on that server before `trayambak mcp auth <name>`.
- **`'x' is a stdio server and needs no OAuth authorization`** — expected:
  stdio servers pass env/args instead of tokens.
- **Bad config silently missing** — invalid entries (both/neither transport,
  unparsable URL) are dropped at load so one bad server can't break the rest;
  re-check with `trayambak mcp list`.

## Sessions problems

- **Index looks broken / sessions won't list** — a corrupt
  `~/.trayambak/sessions.json` is set aside as
  `sessions.json.corrupt-<timestamp>` and the CLI starts with an empty index.
  Copy the backup back to restore.
- **Empty sessions missing from the list** — by design: transcripts with no
  content are skipped.
- **Old single-file transcripts** — `<sessions>/<id>.jsonl` is migrated to
  `<id>/context.jsonl` automatically.

## Update problems

```sh
set TRAYAMBAK_DISABLE_AUTOUPDATE=1   # kill switch (anything but 0/false skips)
trayambak config set autoupdate false
trayambak config set autoupdate notify   # check but only notify
trayambak upgrade                        # manual update: git pull / npm install -g
trayambak upgrade 0.6.0                  # pin a specific version (git)
```

Auto-update only acts on `git` and `npm` installs; a plain source copy prints
manual-update guidance instead.

## Windows notes

- **Shim says `Could not locate trayambak project root.`** — the `bin/*.cmd`
  shims walk up looking for `package.json` + `tsconfig.ink.json`. Either run
  `node scripts/install-global.js` (copies the shims to `~/bin` and sets
  `TRAYAMBAK_HOME`) or set `TRAYAMBAK_HOME` to the repo root yourself.
- **First shim run installs + builds** (`npm install`, `npm run build`) — it
  looks silent/hung for a minute; later runs exec `dist` directly.
- **Shell tool** — on Windows the bash tool prefers Git Bash
  (`C:\Program Files\Git\bin\bash.exe -c`) and falls back to `cmd /c`.
  Override with `TRAYAMBAK_SHELL_COMMAND`.

## Developing against the source

```sh
npm install
npm run build                 # tsc (main) + tsc (ink) + asset copy + fix-esm-imports
node dist/apps/cli/src/index.js --help    # run the built CLI
npm run typecheck             # tsc -p tsconfig.check.json (noEmit)
npm run typecheck:ink         # ink app typecheck
npm run lint                  # eslint apps packages skt
npm test                      # vitest run
npx vitest run --coverage     # coverage (via @vitest/coverage-v8)
npm run check:links           # internal docs links + anchors resolve
```

If the CLI behaves like an old build: `dist/` is stale — rerun
`npm run build`. The CI pipeline (`.github/workflows/ci.yml`) runs the
same commands plus: a **version-sync gate** (`sync-version` + `git
diff --exit-code` on `version.ts`), tests on Node 18/20/22 (Ubuntu) and
Node 20 (Windows), a `coverage` job (`npm run test:coverage`), a
dual-OS build with `--version` and `bin\*.cmd` shim smoke tests on
Windows, a `pack` job (`publish:build` with obfuscation skipped +
`verify:pack`), blocking `npm audit --omit=dev --audit-level=high`, an
uploaded SBOM, schema/docs existence checks (including `npm run
check:links` for internal doc links + anchors), and codespell.

## Debugging aids

| Aid                   | How                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact system prompt   | `trayambak --dump-system-prompt` (offline, no key needed)                                                                                      |
| Input + config trace  | `TRAYAMBAK_DEBUG_INPUT=1` → keystrokes/turn stages to `<os tmpdir>/trayambak-input.log`, config-corruption backups to `./trayambak-config.log` |
| Headless event stream | `trayambak exec "…"` → one JSON event per line                                                                                                 |
| Crash log             | unhandled errors are recorded via `skt/1-errors/mistake.ts` and printed as `trayambak error: <stack>`                                          |
| llama.cpp log         | `~/.trayambak/logs/llama-server.log`                                                                                                           |

Still stuck? [Getting started](getting-started.md) explains the surfaces;
[Security](security.md) covers permissions/sandbox denials (a `deny` there is
usually intentional).
