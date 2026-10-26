# Nemo docs

Documentation for **Nemo CLI** (`nemo` / `nemo`) — a local-first
terminal coding agent by Shrijan.

## Pages

| Page                                  | What's in it                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md) | Install, launch, every subcommand, global flags, configuration precedence, env vars, where files live |
| [Sessions](sessions.md)               | Transcript layout, picker keys, archive/delete, compaction, checkpoints                               |
| [Providers](providers.md)             | The 5 backends, defaults, key handling, model listing, fully local models                             |
| [MCP](mcp.md)                         | Configuring servers, `nemo mcp …`, OAuth tokens, connector registry, `mcp-server`                |
| [ACP](acp.md)                         | `nemo acp` — stdio JSON-RPC methods, examples, when to use it                                    |
| [Web](web.md)                         | `nemo web` — endpoints, SSE agent runs, token auth, CORS                                         |
| [Security](security.md)               | Permissions, sandbox, secret storage, hooks, network exposure                                         |
| [Troubleshooting](troubleshooting.md) | `doctor`-driven diagnosis, 401s, config recovery, Windows shims, debug aids                           |
| [Architecture](architecture.md)       | Monorepo layout, build pipeline, CI, runtime data flow                                                |

## Quick reference

**Install & start**

```sh
npm i -g @shrijan/nemo-cli
nemo          # or: nemo
```

Then inside the session: `/provider` → `/models`. Type `/help` for all
**99 slash commands**, `/keymap` for shortcuts, or press `Ctrl+K` for the
leader overlay.

**Authentication**

```sh
nemo login --with-api-key <key>   # 0600 ~/.nemo/credentials.json
nemo login status
nemo logout
```

`NEMO_API_KEY` is the environment fallback; the config file's `apiKey`
is what the agent reads (see [Providers](providers.md#where-the-key-comes-from)).

**Config**

`~/.nemo/config.json` (0600, atomic, `.bak` rotation); schema:
`config.schema.json`. Precedence: **defaults < file < `NEMO_*` env <
CLI flags**. `nemo config get|set`.

**Sessions**

Index `~/.nemo/sessions.json` + transcripts
`sessions/<uuid>/{context.jsonl,wire.jsonl,state.json}`; `archive` /
`unarchive` / `delete` move or remove them; empty sessions are skipped and
legacy single-file transcripts migrate automatically. Details:
[Sessions](sessions.md).

**Providers**

5 backends: `nvidia`, `nvidia-nim`, `ollama`, `llamacpp`, `custom`.
`verifyProviderKey` does a 1-token chat ping; `cleanApiKey` strips pasted
prefixes. Details: [Providers](providers.md).

**MCP**

Client: stdio + HTTP/SSE transports, 60s default timeout, OAuth 2.0 + PKCE
tokens in `~/.nemo/mcp-auth.json` (0600). `nemo mcp
list|auth|logout|status`. `nemo mcp-server` advertises
`bash`/`read_file`/`write_file`/`grep`/`glob` over stdio (calls are currently
acknowledged stubs). Details: [MCP](mcp.md).

**ACP**

`nemo acp` — line-delimited JSON-RPC over stdio:
`initialize`, `new_session`, `load_session`, `list_sessions`, `set_model`,
`prompt`, `cancel`. Details: [ACP](acp.md).

**Web**

`nemo web --port 8787` → `/health`, `/v1/models`, `/v1/agent` (SSE),
`/api/sessions`, `/openapi.json`; Bearer token via `--token` /
`NEMO_WEB_TOKEN` (loopback by default). Details: [Web](web.md).

**Sandbox**

Policies: `danger-full-access` / `read-only` / `workspace-write` /
`external-sandbox`. Backend detection is honest (`seatbelt`/`bwrap` only
when the binary exists, else `fallback`); enforcement is `policy-only` —
no OS sandbox process is spawned. Details: [Security](security.md).

```sh
nemo sandbox check <file>
nemo execpolicy check <cmd>
```

**Headless**

```sh
nemo exec "prompt"    # one prompt, JSON events on stdout
nemo review [target]  # review changes/files
nemo run "prompt"     # interactive session with the prompt queued
```

**SDK**

`packages/sdk`: `NemoClient.startThread(prompt)` /
`resumeThread(id, prompt)` / `exec(prompt)`.

**Security**

Sandbox + permission layers (deny rules win, read-only tools auto-approve,
everything else asks by default), `0600` secret files, no telemetry at all.
Details: [Security](security.md); reporting SLA and scope in
[`SECURITY.md`](../SECURITY.md). SBOM: `npm run sbom`; publishes use npm
`--provenance`.

**License**

Apache-2.0 — see [`LICENSE`](../LICENSE). Third-party components keep their own terms; see [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
