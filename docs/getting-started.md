# Getting started

Install, launch, connect a provider, and run your first prompt. All commands on
this page are verified against `apps/cli/src/index.ts` (the CLI entry point).

## Requirements

- **Node.js >= 18** (`engines` in `package.json`; `trayambak doctor` fails the
  check on older Node).
- A model provider: a hosted API key (NVIDIA NIM, OpenAI, Anthropic, Google,
  xAI, Hugging Face), a local server (Ollama, llama.cpp), or a custom
  OpenAI-compatible endpoint.

## Install

```sh
npm install -g @skt-ai-labs/trayambak-cli
```

The package installs two equivalent binaries — `trayambak` and the short alias
`skt` — both pointing at the same entry (`dist/apps/cli/src/index.js`).

Working from a source checkout instead? See [Architecture](architecture.md) for
the dev build, and [Troubleshooting](troubleshooting.md) if the CLI shim has to
build on first run.

## Launch

```
trayambak
```

No subcommand starts an interactive session (the Ink REPL —
`packages/tui/src/ink-app`). Running `trayambak chat …` does the same thing.

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
trayambak --provider openai --model gpt-4o
trayambak config set provider openai
trayambak config set apiKey sk-...
trayambak config set model gpt-4o
```

Full details, including the per-provider defaults and key handling, are in
[Providers](providers.md).

## Your first prompts

| You type                            | What happens                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `trayambak`                         | Interactive session (Ink REPL)                                              |
| `trayambak run "explain this repo"` | Interactive session that runs that prompt immediately on launch             |
| `trayambak exec "summarize ./src"`  | Headless: one prompt, newline-delimited JSON events on stdout, then exit    |
| `trayambak review`                  | Headless review of current changes (`trayambak review <file>` for a target) |

Inside the session, `/help` lists the **52 built-in slash commands**
(defined in `packages/tui/src/ink-app/types.ts`), `/keymap` lists every
keyboard shortcut, and `Ctrl+K` opens the leader/which-key overlay.

## Every subcommand

`trayambak help` prints the authoritative list. The 31 visible subcommands
(`chat` is hidden from help because `trayambak` alone starts it):

| Command                                           | Description                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `trayambak` / `trayambak chat`                    | Start an interactive session                                                |
| `run "prompt"`                                    | Interactive session that runs that prompt immediately                       |
| `exec "prompt"`                                   | Headless run, JSON events on stdout                                         |
| `review [target]`                                 | Review code/changes for bugs, security issues, style                        |
| `config get [key]`                                | Show configuration                                                          |
| `config set <key> <value>`                        | Persist a configuration value                                               |
| `doctor`                                          | Diagnose the local environment (exit 1 if any check fails)                  |
| `info`                                            | Runtime & config summary (version, node, platform, model, shell)            |
| `agent [list\|info\|run]`                         | Manage agent profiles                                                       |
| `task [list\|create\|…]`                          | Manage trayambak tasks                                                      |
| `todo [list\|add\|update\|…]`                     | Manage session todos                                                        |
| `plan [create\|list\|show\|…]`                    | Manage multi-step plans                                                     |
| `manager [status\|summary\|…]`                    | Show manager status                                                         |
| `compact [config\|estimate\|run\|reset]`          | Configure/run session compaction                                            |
| `mode [list\|current\|set]`                       | Operating modes (`default`, `plan`, `architect`, `code`, `debug`, `review`) |
| `worktree [list\|create\|remove\|switch]`         | List/switch git worktrees                                                   |
| `mcp [list\|auth\|logout\|status]`                | Manage MCP servers & OAuth                                                  |
| `upgrade [version]`                               | Update trayambak (git pull or `npm install -g`) and rebuild                 |
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
| `--provider <name>`    | One of `llamacpp`, `nvidia`, `nvidia-nim`, `openai`, `xai`, `huggingface`, `anthropic`, `google`, `ollama`, `custom`                                                                                             |
| `--cwd <dir>`          | Working directory for tools                                                                                                                                                                                      |
| `--session <file>`     | Persist the session transcript to a JSON file                                                                                                                                                                    |
| `--config <file>`      | Explicit config file (exported as `TRAYAMBAK_CONFIG`, honored by `configPath()`). Without it config resolves from `./.trayambak/config.json` or `~/.trayambak/config.json` (see [Configuration](#configuration)) |
| `--budget <spec>`      | Session budget: token cap (`50k`, `1.5M`, `50000 tokens`) or turn cap (`40 turns`); `-1` disables. Also `TRAYAMBAK_BUDGET` or `budget` in config; the loop stops with a `budget_exhausted` event when exhausted  |
| `--port <n>`           | Port for `serve` / `web`                                                                                                                                                                                         |
| `--host <addr>`        | Host for `web` (default `127.0.0.1`)                                                                                                                                                                             |
| `--token <t>`          | Bearer token for `web` (else `TRAYAMBAK_WEB_TOKEN`)                                                                                                                                                              |
| `--dev`, `--dev-mode`  | Enable developer mode                                                                                                                                                                                            |
| `--dump-system-prompt` | Print the built system prompt and exit (offline, no key needed)                                                                                                                                                  |
| `--version`, `-v`      | Print version (`trayambak 0.6.0`; `skt 0.6.0` under the `skt` shim)                                                                                                                                              |
| `--help`, `-h`, `help` | Show help                                                                                                                                                                                                        |

Parsing notes (`apps/cli/src/flags.ts`):

- `--flag=value` and `--flag value` are both accepted.
- `--no-<flag>` sets `<flag>` to `false`.
- Shorthands: `-p` → prompt, `-m` → model, `-c` → cwd.
- A leading `-…` in the command position (e.g. `trayambak --ink "hi"`) is
  treated as flags, not an unknown command.

## Configuration

Config file location, in order of preference:

1. `./.trayambak/config.json` — used when a `.trayambak/` directory exists in
   the current working directory.
2. `~/.trayambak/config.json` — otherwise.

Read/write it with the `config` subcommand:

```sh
trayambak config get              # dump every effective key
trayambak config get model        # one key
trayambak config set model gpt-4o # persist (coerces true/false/numbers)
```

Writes are atomic (`tmp` + rename), `0600`, and rotate the previous good file
to `config.json.bak`; an unparseable file is set aside as
`config.json.corrupt-<timestamp>` instead of being overwritten. Keys may be
written kebab-case or flag-style (`trayambak config set --base-url …`) and are
stored as canonical camelCase.

**Precedence** (lowest → highest), from `loadConfig()` in
`apps/runtime/src/config.ts`:

```
built-in defaults  <  config file  <  TRAYAMBAK_* env vars  <  CLI flags
```

The schema is documented in `config.schema.json` (root of the repo) — it covers
`baseUrl`, `model`, `apiKey`, `provider`, `cwd`, `temperature`, `maxTokens`,
`timeoutMs`, `maxTurns`, `maxToolCalls`; the loader accepts many more keys
(`mcpServers`, `permissions`, `hooks`, `providers`, …) than the schema lists.

### Environment variables

The full set read by `loadConfig()`:

| Variable                                                                                                                                                                                    | Sets                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `TRAYAMBAK_BASE_URL`                                                                                                                                                                        | Provider base URL                                                                                                                |
| `TRAYAMBAK_MODEL`                                                                                                                                                                           | Model id                                                                                                                         |
| `TRAYAMBAK_API_KEY`                                                                                                                                                                         | API key (overrides the config file)                                                                                              |
| `TRAYAMBAK_PROVIDER`                                                                                                                                                                        | Provider id                                                                                                                      |
| `TRAYAMBAK_CWD`                                                                                                                                                                             | Tools working directory                                                                                                          |
| `TRAYAMBAK_TEMPERATURE`, `TRAYAMBAK_TOP_P`, `TRAYAMBAK_MAX_TOKENS`, `TRAYAMBAK_CONTEXT_WINDOW`, `TRAYAMBAK_TIMEOUT_MS`                                                                      | Sampling / context limits                                                                                                        |
| `TRAYAMBAK_MAX_TURNS`, `TRAYAMBAK_MAX_TOOL_CALLS`, `TRAYAMBAK_MAX_DISTINCT_TOOL_CALLS`, `TRAYAMBAK_TOOL_CALL_RATE`, `TRAYAMBAK_MAX_PARALLEL_TOOL_CALLS`                                     | Runaway-loop guards                                                                                                              |
| `TRAYAMBAK_MAX_RETRIES`, `TRAYAMBAK_RETRY_DELAY_MS`                                                                                                                                         | Provider retry policy                                                                                                            |
| `TRAYAMBAK_MAX_OUTPUT_LINES`, `TRAYAMBAK_MAX_OUTPUT_BYTES`                                                                                                                                  | Tool-output truncation                                                                                                           |
| `TRAYAMBAK_SHELL_COMMAND`                                                                                                                                                                   | Shell used by the bash tool                                                                                                      |
| `TRAYAMBAK_NATIVE_TOOLS`                                                                                                                                                                    | Native function calling (`true`/`false`)                                                                                         |
| `TRAYAMBAK_MODEL_PATH`, `TRAYAMBAK_LLAMACPP_BIN`                                                                                                                                            | Local GGUF + llama.cpp binary                                                                                                    |
| `TRAYAMBAK_SKILLS_DIR`, `TRAYAMBAK_AGENT_PROFILE_DIRS`                                                                                                                                      | Skills / agent profile dirs                                                                                                      |
| `TRAYAMBAK_MCP_SERVERS`                                                                                                                                                                     | MCP servers as JSON                                                                                                              |
| `TRAYAMBAK_REASONING_EFFORT`                                                                                                                                                                | `low` \| `medium` \| `high` \| `xhigh` \| `max`                                                                                  |
| `TRAYAMBAK_SCRATCHPAD_DIR`                                                                                                                                                                  | Scratchpad directory                                                                                                             |
| `TRAYAMBAK_THEME`, `TRAYAMBAK_CODE_FONT`                                                                                                                                                    | TUI appearance                                                                                                                   |
| `TRAYAMBAK_QUESTION_DEFAULT_OPTION`, `TRAYAMBAK_QUESTION_ANSWER_MODE`                                                                                                                       | Ask-question defaults                                                                                                            |
| `TRAYAMBAK_BROWSER_AUTOMATION_*`                                                                                                                                                            | Browser automation (`ENABLED`, `HEADLESS`, `MAX_PAGES`, `TIMEOUT_MS`, `VIEWPORT_WIDTH`, `VIEWPORT_HEIGHT`, `CAPTURE_SCREENSHOT`) |
| `TRAYAMBAK_MCP_HEALTH_CHECK_ENABLED`, `TRAYAMBAK_MCP_HEALTH_CHECK_INTERVAL_MS`, `TRAYAMBAK_MCP_TOOL_CACHE_ENABLED`, `TRAYAMBAK_MCP_TOOL_CACHE_TTL_MS`, `TRAYAMBAK_MCP_RECONNECT_ON_FAILURE` | MCP health/cache/reconnect                                                                                                       |
| `TRAYAMBAK_AUTOUPDATE`                                                                                                                                                                      | `true`/`1` = apply, `false`/`0` = never, `notify` = notify only                                                                  |

Read elsewhere in the CLI (not by `loadConfig()`):

| Variable                                                                                      | Used by                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `TRAYAMBAK_DISABLE_AUTOUPDATE`                                                                | Auto-update kill switch (any value except `0`/`false` skips updates)                                                                 |
| `TRAYAMBAK_WEB_TOKEN`, `TRAYAMBAK_SERVER_PORT`, `TRAYAMBAK_WEB_ORIGINS`                       | `trayambak web` (origins: extra browser origins; same-origin + loopback always allowed, `*` re-allows all)                           |
| `TRAYAMBAK_CREDENTIALS_FILE`                                                                  | `trayambak login` credentials path                                                                                                   |
| `TRAYAMBAK_SESSIONS_DIR`, `TRAYAMBAK_SESSIONS_FILE`                                           | Session transcripts / index (see [Sessions](sessions.md))                                                                            |
| `TRAYAMBAK_MCP_AUTH_FILE`                                                                     | MCP OAuth token file                                                                                                                 |
| `TRAYAMBAK_GPU_LAYERS`, `TRAYAMBAK_CTX_SIZE`, `TRAYAMBAK_BATCH_SIZE`, `TRAYAMBAK_UBATCH_SIZE` | `trayambak serve` (its model comes from `--model`, else `modelPath`/`TRAYAMBAK_MODEL_PATH`)                                          |
| `TRAYAMBAK_HOME`                                                                              | Project-root override — the `bin/*.cmd` and `~/bin` shims resolve it first; auto-update, `upgrade`, and the memory tool honor it too |
| `TRAYAMBAK_BIN_NAME`                                                                          | Help-text binary name (`skt` vs `trayambak`)                                                                                         |
| `TRAYAMBAK_DEBUG_INPUT=1`                                                                     | Debug tracing: keystrokes/turn stages → `<os tmpdir>/trayambak-input.log`; config-corruption backups → `./trayambak-config.log`      |

## Credentials

```sh
trayambak login --with-api-key nvapi-...   # writes ~/.trayambak/credentials.json (0600, atomic)
trayambak login status                     # auth: api-key|env|none (file=… env=…)
trayambak logout                           # deletes the credentials file
```

`TRAYAMBAK_API_KEY` in the environment is reported by `login status` as the
`env` source. The agent itself resolves its key from config/`TRAYAMBAK_API_KEY`
(see [Providers](providers.md#where-the-key-comes-from)).

## Where things live

| Path                                 | Contents                            |
| ------------------------------------ | ----------------------------------- |
| `~/.trayambak/config.json`           | Configuration (0600)                |
| `~/.trayambak/credentials.json`      | `trayambak login` API key (0600)    |
| `~/.trayambak/sessions/<id>/`        | Session transcripts (0600)          |
| `~/.trayambak/sessions.json`         | Session index (0600)                |
| `~/.trayambak/mcp-auth.json`         | MCP OAuth tokens (0600)             |
| `~/.trayambak/logs/llama-server.log` | llama.cpp server log                |
| `./.scratchpad/`                     | Scratchpad for temp files (default) |

## Diagnostics

```sh
trayambak doctor   # Node, config file, GGUF model, llama.cpp binary, endpoint reachability
trayambak info     # version, node, platform, cwd, baseUrl, model, shell, maxTurns, tools
```

`doctor` exits `1` when any check fails — see
[Troubleshooting](troubleshooting.md).

## Next steps

- [Sessions](sessions.md) — history, resume, checkpoints, compaction.
- [Providers](providers.md) — all 10 backends, key handling, local models.
- [MCP](mcp.md) · [ACP](acp.md) · [Web](web.md) — integration surfaces.
- [Security](security.md) — sandbox, permissions, secrets.
- [Architecture](architecture.md) — how the repo and build fit together.
