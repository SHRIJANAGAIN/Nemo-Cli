# Trayambak docs

Documentation for **Trayambak CLI** (`trayambak` / `skt`) — a local-first
terminal coding agent by SKT AI LABS PRIVATE LIMITED.

## Pages

| Page | What's in it |
| --- | --- |
| [Getting started](getting-started.md) | Install, launch, every subcommand, global flags, configuration precedence, env vars, where files live |
| [Sessions](sessions.md) | Transcript layout, picker keys, archive/delete, compaction, checkpoints |
| [Providers](providers.md) | The 10 backends, defaults, key handling, model listing, fully local models |
| [MCP](mcp.md) | Configuring servers, `trayambak mcp …`, OAuth tokens, connector registry, `mcp-server` |
| [ACP](acp.md) | `trayambak acp` — stdio JSON-RPC methods, examples, when to use it |
| [Web](web.md) | `trayambak web` — endpoints, SSE agent runs, token auth, CORS |
| [Security](security.md) | Permissions, sandbox, secret storage, hooks, network exposure |
| [Troubleshooting](troubleshooting.md) | `doctor`-driven diagnosis, 401s, config recovery, Windows shims, debug aids |
| [Architecture](architecture.md) | Monorepo layout, build pipeline, CI, runtime data flow |

## Quick reference

**Install & start**

```sh
npm i -g @skt-ai-labs/trayambak-cli
trayambak          # or: skt
```

Then inside the session: `/provider` → `/models`. Type `/help` for all
**52 slash commands**, `/keymap` for shortcuts, or press `Ctrl+K` for the
leader overlay.

**Authentication**

```sh
trayambak login --with-api-key <key>   # 0600 ~/.trayambak/credentials.json
trayambak login status
trayambak logout
```

`TRAYAMBAK_API_KEY` is the environment fallback; the config file's `apiKey`
is what the agent reads (see [Providers](providers.md#where-the-key-comes-from)).

**Config**

`~/.trayambak/config.json` (0600, atomic, `.bak` rotation); schema:
`config.schema.json`. Precedence: **defaults < file < `TRAYAMBAK_*` env <
CLI flags**. `trayambak config get|set`.

**Sessions**

Index `~/.trayambak/sessions.json` + transcripts
`sessions/<uuid>/{context.jsonl,wire.jsonl,state.json}`; `archive` /
`unarchive` / `delete` move or remove them; empty sessions are skipped and
legacy single-file transcripts migrate automatically. Details:
[Sessions](sessions.md).

**Providers**

10 backends: `llamacpp`, `nvidia`, `nvidia-nim`, `openai`, `xai`,
`huggingface`, `anthropic`, `google`, `ollama`, `custom`.
`verifyProviderKey` does a 1-token chat ping; `cleanApiKey` strips pasted
prefixes. Details: [Providers](providers.md).

**MCP**

Client: stdio + HTTP/SSE transports, 60s default timeout, OAuth 2.0 + PKCE
tokens in `~/.trayambak/mcp-auth.json` (0600). `trayambak mcp
list|auth|logout|status`. `trayambak mcp-server` advertises
`bash`/`read_file`/`write_file`/`grep`/`glob` over stdio (calls are currently
acknowledged stubs). Details: [MCP](mcp.md).

**ACP**

`trayambak acp` — line-delimited JSON-RPC over stdio:
`initialize`, `new_session`, `load_session`, `list_sessions`, `set_model`,
`prompt`, `cancel`. Details: [ACP](acp.md).

**Web**

`trayambak web --port 8787` → `/health`, `/v1/models`, `/v1/agent` (SSE),
`/api/sessions`, `/openapi.json`; Bearer token via `--token` /
`TRAYAMBAK_WEB_TOKEN` (loopback by default). Details: [Web](web.md).

**Sandbox**

Policies: `danger-full-access` / `read-only` / `workspace-write` /
`external-sandbox`. Backend detection is honest (`seatbelt`/`bwrap` only
when the binary exists, else `fallback`); enforcement is `policy-only` —
no OS sandbox process is spawned. Details: [Security](security.md).

```sh
trayambak sandbox check <file>
trayambak execpolicy check <cmd>
```

**Headless**

```sh
trayambak exec "prompt"    # one prompt, JSON events on stdout
trayambak review [target]  # review changes/files
trayambak run "prompt"     # interactive session with the prompt queued
```

**SDK**

`packages/sdk`: `TrayambakClient.startThread(prompt)` /
`resumeThread(id, prompt)` / `exec(prompt)`.

**Security**

Sandbox + permission layers (deny rules win, read-only tools auto-approve,
everything else asks by default), `0600` secret files, telemetry off by
default. Details: [Security](security.md); reporting SLA and scope in
[`SECURITY.md`](../SECURITY.md). SBOM: `npm run sbom`; publishes use npm
`--provenance`.

**License**

Apache-2.0 — see [`LICENSE`](../LICENSE) (Apache License 2.0, SKT AI LABS PRIVATE LIMITED).
