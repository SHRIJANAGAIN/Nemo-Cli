# Getting started

Install, launch, connect a provider, and run your first prompt. All commands on
this page are verified against `apps/cli/src/index.ts` (the CLI entry point).

## Requirements

- **Node.js >= 18** (`engines` in `package.json`; `nemo doctor` fails the
  check on older Node).
- A model provider: a hosted NVIDIA API key (NVIDIA / NVIDIA NIM), a local
  server (Ollama, llama.cpp), or a custom OpenAI-compatible endpoint.

## Install

```sh
npm install -g @shrijanagain/nemo-cli
```

The package installs two equivalent binaries — `nemo` and the short alias
`nemo` — both pointing at the same entry (`dist/apps/cli/src/index.js`).

Working from a source checkout instead? See [Architecture](architecture.md) for
the dev build, and [Troubleshooting](troubleshooting.md) if the CLI shim has to
build on first run.

## Launch

```
nemo
```

No subcommand starts an interactive session (the Ink REPL —
`packages/tui/src/ink-app`). Running `nemo chat …` does the same thing.

## Connect a provider

Inside the REPL:

```
/provider
```

The chooser walks you through **backend → API key → live model list → model**.
A saved key switches backends directly without re-pasting. Then pick a model:

```
/models
```

Outside the REPL you can do the same thing with flags and config:

```sh
nemo --provider nvidia --model nvidia/nemotron-3-super-120b-a12b
nemo config set provider nvidia
nemo config set apiKey nvapi-...
nemo config set model nvidia/nemotron-3-super-120b-a12b
```

Full details, including the per-provider defaults and key handling, are in
[Providers](providers.md).

## Your first prompts

| You type                            | What happens                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `nemo`                         | Interactive session (Ink REPL)                                              |
| `nemo run "explain this repo"` | Interactive session that runs that prompt immediately on launch             |
| `nemo exec "summarize ./src"`  | Headless: one prompt, newline-delimited JSON events on stdout, then exit    |
| `nemo review`                  | Headless review of current changes (`nemo review <file>` for a target) |

Inside the session, `/help` lists the **52 built-in slash commands**
(defined in `packages/tui/src/ink-app/types.ts`), `/keymap` lists every
keyboard shortcut, and `Ctrl+K` opens the leader/which-key overlay.

## Every subcommand

`nemo help` prints the authoritative list. The 31 visible subcommands
(`chat` is hidden from help because `nemo` alone starts it):

| Command                                           | Description                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `nemo` / `nemo chat`                    | Start an interactive session                                                |
| `run "prompt"`                                    | Interactive session that runs that prompt immediately                       |
| `exec "prompt"`                                   | Headless run, JSON events on stdout                                         |
| `review [target]`                                 | Review code/changes for bugs, security issues, style                        |
| `config get [key]`                                | Show configuration                                                          |
| `config set <key> <value>`                        | Persist a configuration value                                               |
| `doctor`                                          | Diagnose the local environment (exit 1 if any check fails)                  |
| `info`                                            | Runtime & config summary (version, node, platform, model, shell)            |
| `agent [list\|info\|run]`                         | Manage agent profiles                                                       |
| `task [list\|create\|…]`                          | Manage nemo tasks                                                      |
| `todo [list\|add\|update\|…]`                     | Manage session todos                                                        |
| `plan [create\|list\|show\|…]`                    | Manage multi-step plans                                                     |
| `manager [status\|summary\|…]`                    | Show manager status                                                         |
| `compact [config\|estimate\|run\|reset]`          | Configure/run session compaction                                            |
| `mode [list\|current\|set]`                       | Operating modes (`default`, `plan`, `architect`, `code`, `debug`, `review`) |
| `worktree [list\|create\|remove\|switch]`         | List/switch git worktrees                                                   |
| `mcp [list\|auth\|logout\|status]`                | Manage MCP servers & OAuth                                                  |
| `upgrade [version]`                               | Update nemo (git pull or `npm install -g`) and rebuild                 |
| `serve [--port 8080]`                             | Start a local llama.cpp server                                              |
| `download <org/model>`                            | Download a GGUF model (`[file.gguf] [--output <path>]`)                     |
| `acp`                                             | Run as an ACP agent server (stdio JSON-RPC)                                 |
| `web [--port 8787]`                               | HTTP agent API + `/api/sessions` + `/openapi.json`                          |
| `login [--with-api-key K \| status]`              | Store/report credentials                                                    |
| `logout`                                          | Delete stored credentials                                                   |
| `archive <id>` / `unarchive <id>` / `delete <id>` | Manage saved sessions                                                       |
| `mcp-server`                                      | Expose a small tool set to MCP clients over stdio                           |
| `sandbox check <file>`                            | Check the sandbox policy for a file operation                               |
| `execpolicy check <cmd>`                          | Check the exec rule engine for a command                                    |
| `resume <id>`                                     | Resume a stored session                                                     |
| `export [id] [--format markdown\|json\|text]`     | Export a session transcript (default `markdown`)                            |
| `completion <bash\|zsh\|fish\|powershell>`        | Print a shell completion script                                             |

An unknown command prints help and exits `2` (the usage code).

## Global flags

| Flag                   | Meaning                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--base-url <url>`     | Provider base URL (per-provider default — see [Providers](providers.md))                                                                                                                                         |
| `--model <name>`       | Model id to request                                                                                                                                                                                              |
| `--provider <name>`    | One of `nvidia`, `nvidia-nim`, `ollama`, `llamacpp`, `custom`                                                                                                                                                   |
| `--cwd <dir>`          | Working directory for tools                                                                                                                                                                                      |
| `--session <file>`     | Persist the session transcript to a JSON file                                                                                                                                                                    |
| `--config <file>`      | Explicit config file (exported as `NEMO_CONFIG`, honored by `configPath()`). Without it config resolves from `./.nemo/config.json` or `~/.nemo/config.json` (see [Configuration](#configuration)) |
| `--budget <spec>`      | Session budget: token cap (`50k`, `1.5M`, `50000 tokens`) or turn cap (`40 turns`); `-1` disables. Also `NEMO_BUDGET` or `budget` in config; the loop stops with a `budget_exhausted` event when exhausted  |
| `--port <n>`           | Port for `serve` / `web`                                                                                                                                                                                         |
| `--host <addr>`        | Host for `web` (default `127.0.0.1`)                                                                                                                                                                             |
| `--token <t>`          | Bearer token for `web` (else `NEMO_WEB_TOKEN`)                                                                                                                                                              |
| `--dev`, `--dev-mode`  | Enable developer mode                                                                                                                                                                                            |
| `--version`, `-v`      | Print version (`nemo 0.6.0`; `nemo 0.6.0` under the `nemo` shim)                                                                                                                                              |
| `--help`, `-h`, `help` | Show help                                                                                                                                                                                                        |

Parsing notes (`apps/cli/src/flags.ts`):

- `--flag=value` and `--flag value` are both accepted.
- `--no-<flag>` sets `<flag>` to `false`.
- Shorthands: `-p` → prompt, `-m` → model, `-c` → cwd.
- A leading `-…` in the command position (e.g. `nemo --ink "hi"`) is
  treated as flags, not an unknown command.

## Configuration

Config file location, in order of preference:

1. `./.nemo/config.json` — used when a `.nemo/` directory exists in
   the current working directory.
2. `~/.nemo/config.json` — otherwise.

Read/write it with the `config` subcommand:

```sh
nemo config get              # dump every effective key
nemo config get model        # one key
nemo config set model gpt-4o # persist (coerces true/false/numbers)
```

Writes are atomic (`tmp` + rename), `0600`, and rotate the previous good file
to `config.json.bak`; an unparseable file is set aside as
`config.json.corrupt-<timestamp>` instead of being overwritten. Keys may be
written kebab-case or flag-style (`nemo config set --base-url …`) and are
stored as canonical camelCase.

**Precedence** (lowest → highest), from `loadConfig()` in
`apps/runtime/src/config.ts`:

```
built-in defaults  <  config file  <  NEMO_* env vars  <  CLI flags
```

The schema is documented in `config.schema.json` (root of the repo) — it covers
`baseUrl`, `model`, `apiKey`, `provider`, `cwd`, `temperature`, `maxTokens`,
`timeoutMs`, `maxTurns`, `maxToolCalls`; the loader accepts many more keys
(`mcpServers`, `permissions`, `hooks`, `providers`, …) than the schema lists.

### Environment variables

The full set read by `loadConfig()`:

| Variable                                                                                                                                                                                    | Sets                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `NEMO_BASE_URL`                                                                                                                                                                        | Provider base URL                                                                                                                |
| `NEMO_MODEL`                                                                                                                                                                           | Model id                                                                                                                         |
| `NEMO_JUDGE_MODEL`                                                                                                                                                                     | Decision-maker model id for sota search verdicts (local-only: llama.cpp/Ollama; falls back to the worker model)                  |
| `NEMO_API_KEY`                                                                                                                                                                         | API key (overrides the config file)                                                                                              |
| `NEMO_PROVIDER`                                                                                                                                                                        | Provider id                                                                                                                      |
| `NEMO_CWD`                                                                                                                                                                             | Tools working directory                                                                                                          |
| `NEMO_TEMPERATURE`, `NEMO_TOP_P`, `NEMO_MAX_TOKENS`, `NEMO_CONTEXT_WINDOW`, `NEMO_TIMEOUT_MS`                                                                      | Sampling / context limits                                                                                                        |
| `NEMO_MAX_TURNS`, `NEMO_MAX_TOOL_CALLS`, `NEMO_MAX_DISTINCT_TOOL_CALLS`, `NEMO_TOOL_CALL_RATE`, `NEMO_MAX_PARALLEL_TOOL_CALLS`                                     | Runaway-loop guards                                                                                                              |
| `NEMO_MAX_RETRIES`, `NEMO_RETRY_DELAY_MS`                                                                                                                                         | Provider retry policy                                                                                                            |
| `NEMO_MAX_OUTPUT_LINES`, `NEMO_MAX_OUTPUT_BYTES`                                                                                                                                  | Tool-output truncation                                                                                                           |
| `NEMO_SHELL_COMMAND`                                                                                                                                                                   | Shell used by the bash tool                                                                                                      |
| `NEMO_NATIVE_TOOLS`                                                                                                                                                                    | Native function calling (`true`/`false`)                                                                                         |
| `NEMO_MODEL_PATH`, `NEMO_LLAMACPP_BIN`                                                                                                                                            | Local GGUF + llama.cpp binary                                                                                                    |
| `NEMO_SKILLS_DIR`, `NEMO_AGENT_PROFILE_DIRS`                                                                                                                                      | Skills / agent profile dirs                                                                                                      |
| `NEMO_MCP_SERVERS`                                                                                                                                                                     | MCP servers as JSON                                                                                                              |
| `NEMO_REASONING_EFFORT`                                                                                                                                                                | `low` \| `medium` \| `high` \| `xhigh` \| `max`                                                                                  |
| `NEMO_SCRATCHPAD_DIR`                                                                                                                                                                  | Scratchpad directory                                                                                                             |
| `NEMO_THEME`, `NEMO_CODE_FONT`                                                                                                                                                    | TUI appearance                                                                                                                   |
| `NEMO_QUESTION_DEFAULT_OPTION`, `NEMO_QUESTION_ANSWER_MODE`                                                                                                                       | Ask-question defaults                                                                                                            |
| `NEMO_BROWSER_AUTOMATION_*`                                                                                                                                                            | Browser automation (`ENABLED`, `HEADLESS`, `MAX_PAGES`, `TIMEOUT_MS`, `VIEWPORT_WIDTH`, `VIEWPORT_HEIGHT`, `CAPTURE_SCREENSHOT`) |
| `NEMO_MCP_HEALTH_CHECK_ENABLED`, `NEMO_MCP_HEALTH_CHECK_INTERVAL_MS`, `NEMO_MCP_TOOL_CACHE_ENABLED`, `NEMO_MCP_TOOL_CACHE_TTL_MS`, `NEMO_MCP_RECONNECT_ON_FAILURE` | MCP health/cache/reconnect                                                                                                       |
| `NEMO_AUTOUPDATE`                                                                                                                                                                      | `true`/`1` = apply, `false`/`0` = never, `notify` = notify only                                                                  |

Read elsewhere in the CLI (not by `loadConfig()`):

| Variable                                                                                      | Used by                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `NEMO_DISABLE_AUTOUPDATE`                                                                | Auto-update kill switch (any value except `0`/`false` skips updates)                                                                 |
| `NEMO_WEB_TOKEN`, `NEMO_SERVER_PORT`, `NEMO_WEB_ORIGINS`                       | `nemo web` (origins: extra browser origins; same-origin + loopback always allowed, `*` re-allows all)                           |
| `NEMO_CREDENTIALS_FILE`                                                                  | `nemo login` credentials path                                                                                                   |
| `NEMO_SESSIONS_DIR`, `NEMO_SESSIONS_FILE`                                           | Session transcripts / index (see [Sessions](sessions.md))                                                                            |
| `NEMO_MCP_AUTH_FILE`                                                                     | MCP OAuth token file                                                                                                                 |
| `NEMO_GPU_LAYERS`, `NEMO_CTX_SIZE`, `NEMO_BATCH_SIZE`, `NEMO_UBATCH_SIZE` | `nemo serve` (its model comes from `--model`, else `modelPath`/`NEMO_MODEL_PATH`)                                          |
| `NEMO_HOME`                                                                              | Project-root override — the `bin/*.cmd` and `~/bin` shims resolve it first; auto-update, `upgrade`, and the memory tool honor it too |
| `NEMO_BIN_NAME`                                                                          | Help-text binary name (`nemo` vs `nemo`)                                                                                         |
| `NEMO_DEBUG_INPUT=1`                                                                     | Debug tracing: keystrokes/turn stages → `<os tmpdir>/nemo-input.log`; config-corruption backups → `./nemo-config.log`      |

## Credentials

```sh
nemo login --with-api-key nvapi-...   # writes ~/.nemo/credentials.json (0600, atomic)
nemo login status                     # auth: api-key|env|none (file=… env=…)
nemo logout                           # deletes the credentials file
```

`NEMO_API_KEY` in the environment is reported by `login status` as the
`env` source. The agent itself resolves its key from config/`NEMO_API_KEY`
(see [Providers](providers.md#where-the-key-comes-from)).

## Where things live

| Path                                 | Contents                            |
| ------------------------------------ | ----------------------------------- |
| `~/.nemo/config.json`           | Configuration (0600)                |
| `~/.nemo/credentials.json`      | `nemo login` API key (0600)    |
| `~/.nemo/sessions/<id>/`        | Session transcripts (0600)          |
| `~/.nemo/sessions.json`         | Session index (0600)                |
| `~/.nemo/mcp-auth.json`         | MCP OAuth tokens (0600)             |
| `~/.nemo/logs/llama-server.log` | llama.cpp server log                |
| `./.scratchpad/`                     | Scratchpad for temp files (default) |

## Diagnostics

```sh
nemo doctor   # Node, config file, GGUF model, llama.cpp binary, endpoint reachability
nemo info     # version, node, platform, cwd, baseUrl, model, shell, maxTurns, tools
```

`doctor` exits `1` when any check fails — see
[Troubleshooting](troubleshooting.md).

## Next steps

- [Sessions](sessions.md) — history, resume, checkpoints, compaction.
- [Providers](providers.md) — all 5 backends, key handling, local models.
- [MCP](mcp.md) · [ACP](acp.md) · [Web](web.md) — integration surfaces.
- [Security](security.md) — sandbox, permissions, secrets.
- [Architecture](architecture.md) — how the repo and build fit together.
