# MCP — Model Context Protocol

Trayambak is an MCP **client** (it runs other people's servers and exposes
their tools to the agent) and can also act as a minimal MCP **server** (it
exposes a few tools to other clients over stdio).

## Configuring servers

Servers live under `mcpServers` in `config.json` (or as a JSON blob in
`TRAYAMBAK_MCP_SERVERS`). Each entry has **exactly one** transport — a stdio
`command` **or** an HTTP `url`:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_..." },
      "timeoutMs": 60000,
    },
    "acme-http": {
      "url": "https://mcp.acme.dev/sse",
      "headers": { "X-Api-Key": "..." },
      "oauth": true,
    },
    "local-no-oauth": {
      "url": "http://127.0.0.1:3000/mcp",
      "oauth": false,
    },
  },
}
```

| Field       | Meaning                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `command`   | argv array for a stdio server (max 32 entries)                                                                             |
| `url`       | `http://` or `https://` endpoint (HTTP transport with SSE responses)                                                       |
| `env`       | string map passed to the child process                                                                                     |
| `headers`   | string map sent with HTTP requests                                                                                         |
| `cwd`       | working directory for the child                                                                                            |
| `timeoutMs` | per-call timeout, clamped to 1 000–600 000 ms (default **60 000 ms**)                                                      |
| `oauth`     | `false` disables OAuth for this server; an object tunes `clientId`, `clientSecret`, `scope`, `callbackPort`, `redirectUri` |

Validation happens at load (`cleanMcpServers()`): malformed entries, URLs that
don't parse, and specs with both/neither transport are **dropped individually**
so one bad server never takes down the others.

## How tools reach the model

Connected tools are registered as:

```
mcp__<server>__<tool>            # a remote tool
mcp__<server>__read_resource_<slug>
mcp__<server>__get_prompt_<slug>
mcp__<server>__error             # surfaced error tool for that server
```

Runtime knobs (config key → env var, from `loadConfig()`):

| Key                        | Env var                                  | Default           | Meaning                               |
| -------------------------- | ---------------------------------------- | ----------------- | ------------------------------------- |
| `mcpToolCacheEnabled`      | `TRAYAMBAK_MCP_TOOL_CACHE_ENABLED`       | `true`            | Cache `listTools` results             |
| `mcpToolCacheTtlMs`        | `TRAYAMBAK_MCP_TOOL_CACHE_TTL_MS`        | `300000` (5 min)  | Cache TTL                             |
| `mcpReconnectOnFailure`    | `TRAYAMBAK_MCP_RECONNECT_ON_FAILURE`     | `true`            | Reconnect after transport failure     |
| `mcpHealthCheckEnabled`    | `TRAYAMBAK_MCP_HEALTH_CHECK_ENABLED`     | `false`           | Periodic connection health monitoring |
| `mcpHealthCheckIntervalMs` | `TRAYAMBAK_MCP_HEALTH_CHECK_INTERVAL_MS` | `30000` (min 5 s) | Health-check interval                 |

Client implementation: `packages/mcp/src/index.ts` (stdio spawn + HTTP/SSE,
60s default timeout, liveness-checked reconnects).

## Managing servers from the shell

```sh
trayambak mcp list                 # every configured server: transport + auth status
trayambak mcp auth <name>          # run the OAuth 2.0 + PKCE flow for a remote server
trayambak mcp status <name>        # auth status for one server
trayambak mcp logout <name>        # delete stored tokens for that server
```

`list` prints one line per server, e.g.

```
github  [stdio]  auth: -
acme-http  [http]  auth: authenticated
```

Auth status is one of `authenticated`, `expired`, `not_authenticated`
(`getMcpAuthStatus`). A remote server that is `not_authenticated` gets a hint:
`Run: trayambak mcp auth <name>`.

If nothing is configured you get:

```
No MCP servers configured (config `mcpServers` or TRAYAMBAK_MCP_SERVERS).
```

Usage errors (missing name, unknown action) print the usage line and exit `1`.

## OAuth tokens

- Flow: OAuth 2.0 + PKCE with a localhost callback
  (`packages/mcp/src/oauth.ts`, callback times out after 5 minutes).
- Storage: `~/.trayambak/mcp-auth.json`, mode `0600`; override the path with
  `TRAYAMBAK_MCP_AUTH_FILE`.
- `trayambak mcp logout <name>` revokes the local entry. Never commit or paste
  this file — see [Security](security.md).

## Discovering servers (connector registry)

The runtime ships a curated connector registry
(`apps/runtime/src/tools/mcp/registry.ts`): GitHub, Slack, Google Drive,
Google Calendar, Gmail, filesystem, Postgres, SQLite, Brave Search, Docker,
Kubernetes, Redis, MongoDB, Notion, Linear, Jira, Stripe, Figma, Puppeteer,
Obsidian, Exa, sequential-thinking, and more — each with a ready `spec`
(usually `npx -y @modelcontextprotocol/server-…`) and an optional `npmPackage`
that `mcp__install` (`apps/runtime/src/tools/mcp/mcp-install.ts`) can install
for you. Tool search filters by prefix (`mcp-` / `mcp__`).

In the REPL, `/mcp` currently reports where servers are configured
(`.trayambak/config.json`); day-to-day management is the `trayambak mcp …`
CLI above.

## Trayambak as an MCP server

```sh
trayambak mcp-server
```

Speaks JSON-RPC 2.0 over stdio (protocol `2024-11-05`) and answers
`initialize`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`
(`packages/mcp-server/src/index.ts`).

`tools/list` advertises five tools — `bash`, `read_file`, `write_file`,
`grep`, `glob`. Executing tools (`bash`, `read_file`) pass the same gate
as the agent loop, in order: PreToolUse hooks → `approvalFor()` →
exec-policy (`bash`) / allowed-root check (`read_file`) → bounded execution
→ PostToolUse hooks. There is no interactive approver over stdio, so an
`ask` verdict refuses instead of prompting; only explicit allows (and
full-access) proceed. `bash` takes an optional `timeoutMs` (1s–5min,
default 10s); `read_file` is confined to the configured `cwd` (symlinks
and junctions resolved first). `write_file`/`grep`/`glob` are advertised
but refuse execution — use the CLI tools instead.

## Related

- [Security](security.md) — token storage and MCP in the security scope.
- [Providers](providers.md) — keys used alongside MCP servers.
- [Architecture](architecture.md) — where the MCP packages sit.
