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
- **Agent identity:** `{ name: "trayambak", version: "0.5.0" }`.
- **Malformed lines** are ignored; unknown methods return
  `-32601 unknown method: …`.

## Methods

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | — | `{ protocolVersion: 1, agentCapabilities: { loadSession, prompt, mcp, sessions }, agentInfo }` |
| `new_session` | `workDir?` | `{ sessionId }` — creates a transcript under the sessions root |
| `load_session` / `resume_session` | `sessionId` | `{ sessionId, state }`, or error `-32601 session not found: <id>` |
| `list_sessions` | — | array of `{ sessionId, title, updatedAt, workDir, … }` |
| `set_model` | `model` | `{ ok: true, model }` |
| `prompt` | `sessionId?`, `prompt`, `model?` | `{ sessionId, stopReason: "end_turn" \| "cancelled" }` |
| `cancel` | `sessionId` | `{ ok: true }` — stops streaming for that session |

While a `prompt` runs, the server emits notifications:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","event":{…}}}
```

## Example session

Request → response pairs, one JSON object per line:

```jsonc
// →
{"jsonrpc":"2.0","id":1,"method":"initialize"}
// ←
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"prompt":true,"mcp":true,"sessions":true},"agentInfo":{"name":"trayambak","version":"0.5.0"}}}

// →
{"jsonrpc":"2.0","id":2,"method":"new_session","params":{"workDir":"C:\\proj"}}
// ←
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"6f1c…"}}

// →
{"jsonrpc":"2.0","id":3,"method":"prompt","params":{"sessionId":"6f1c…","prompt":"list the build scripts"}}
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

| Surface | Use it for |
| --- | --- |
| `trayambak` (Ink REPL) | Humans in a terminal |
| `trayambak acp` | ACP-capable editors/clients driving sessions over stdio |
| `trayambak web` | HTTP/SSE integrations ([Web](web.md)) |
| `trayambak mcp-server` | Exposing a small tool set to MCP clients ([MCP](mcp.md)) |
| `trayambak exec` | Scripts: one prompt, JSONL events on stdout |

## Related

- [Sessions](sessions.md) — the transcript store ACP reads and writes.
- [Getting started](getting-started.md) — flags and config precedence.
- [Architecture](architecture.md) — where `packages/acp` sits in the build.
