# ACP — Agent Client Protocol

`trayambak acp` runs Trayambak as an **Agent Client Protocol server over
stdio**: line-delimited JSON-RPC 2.0, one request/response per line. Editors
and other ACP clients spawn the process, send requests on stdin, and read
replies plus `session/update` notifications on stdout.

Source: `packages/acp/src/index.ts`.

## Running it

```sh
trayambak acp
```

The process stays up until stdin closes. It logs nothing on stdout except
JSON-RPC frames, so it is safe to pipe.

## Protocol

- **Transport:** one JSON object per line (JSON-RPC 2.0), `crlfDelay: Infinity`.
- **Protocol version:** `1`.
- **Agent identity:** `agentInfo: { name: "trayambak", version }` — see
  `packages/acp/src/index.ts`.
- **Malformed lines** are ignored; unknown methods return
  `-32601 unknown method: …`.

## Methods

Every method is accepted under its [ACP spec](https://agentclientprotocol.com/protocol/v1/overview)
name **and** the short name it replaced, so spec clients and older callers drive
the same server:

| Spec name / short name                                                 | Params                                    | Result                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `initialize`                                                           | `protocolVersion`, `clientCapabilities?`  | `{ protocolVersion: 1, agentCapabilities, agentInfo }`                   |
| `session/new` / `new_session`                                          | `cwd` (spec) or `workDir?`, `mcpServers?` | `{ sessionId }` — creates a transcript under the sessions root           |
| `session/load`, `session/resume` / `load_session`, `resume_session`    | `sessionId`                               | `{ sessionId, state }`, or error `-32001 session not found: <id>`        |
| `session/prompt` / `prompt`                                            | `sessionId?`, `prompt`, `model?`          | `{ sessionId, stopReason: "end_turn" \| "cancelled" }`                   |
| `session/cancel` / `cancel`                                            | `sessionId`                               | `{ ok: true }` only when sent with an `id`; a bare notification replies with nothing |
| `list_sessions`, `set_model`                                           | —                                         | Trayambak extensions — no spec equivalent, and not advertised            |

`prompt` is a `ContentBlock[]` per spec; a bare string is also accepted, and a
block list with no `text` block in it errors with `-32602 missing 'prompt'`.
`session/list` is deliberately not aliased: the spec's response shape differs
from Trayambak's array, and the capability is never advertised.

While a `prompt` runs, the server emits notifications. `update` is an ACP
`SessionUpdate` union member — internal agent events that have no ACP variant
are dropped rather than forwarded:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}}}
```

| Agent event                       | `sessionUpdate`                  |
| --------------------------------- | -------------------------------- |
| `message_update` + `delta.text`   | `agent_message_chunk`            |
| `message_update` + `delta.thinking`, `thinking` | `agent_thought_chunk` |
| `tool_execution_start`            | `tool_call` (`in_progress`)      |
| `tool_execution_update`           | `tool_call_update` (`in_progress`) |
| `tool_execution_end`              | `tool_call_update` (`completed` / `failed`) |
| everything else                   | dropped                          |

## Example session

Request → response pairs, one JSON object per line:

```jsonc
// →
{"jsonrpc":"2.0","id":1,"method":"initialize"}
// ←
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"mcpCapabilities":{"http":false,"sse":false,"acp":false},"sessionCapabilities":{},"auth":{}},"agentInfo":{"name":"trayambak","version":"<package version>"}}}

// →  (short name `new_session` + `workDir` also works)
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"C:\\proj","mcpServers":[]}}
// ←
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"6f1c…"}}

// →  (short name `prompt` + a bare string prompt also works)
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"6f1c…","prompt":[{"type":"text","text":"list the build scripts"}]}}
// ← notifications, then:
{"jsonrpc":"2.0","id":3,"result":{"sessionId":"6f1c…","stopReason":"end_turn"}}
```

Notes verified in code:

- `prompt` without `sessionId` creates one for you.
- `prompt` without `prompt` returns error `-32602 missing 'prompt'`.
- `model` in `prompt` params overrides the configured model for that run.
- `cancel` marks the session cancelled; subsequent `session/update`
  notifications for it are suppressed.
- Errors during a run return `-32000` with the message.
- Each `prompt` builds a fresh `Agent` from `loadConfig()` — the same config,
  permissions, sandbox, and tools as the interactive CLI.

## When to use which surface

| Surface                | Use it for                                               |
| ---------------------- | -------------------------------------------------------- |
| `trayambak` (Ink REPL) | Humans in a terminal                                     |
| `trayambak acp`        | ACP-capable editors/clients driving sessions over stdio  |
| `trayambak web`        | HTTP/SSE integrations ([Web](web.md))                    |
| `trayambak mcp-server` | Exposing a small tool set to MCP clients ([MCP](mcp.md)) |
| `trayambak exec`       | Scripts: one prompt, JSONL events on stdout              |

## Related

- [Sessions](sessions.md) — the transcript store ACP reads and writes.
- [Getting started](getting-started.md) — flags and config precedence.
- [Architecture](architecture.md) — where `packages/acp` sits in the build.
