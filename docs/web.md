# Web — local HTTP agent API

`trayambak web` starts a small JSON/SSE server that exposes the agent over
HTTP on your machine. Source: `packages/server/src/index.ts`.

## Starting it

```sh
trayambak web                      # http://127.0.0.1:8787
trayambak web --port 9000          # custom port
trayambak web --host 127.0.0.1     # default host; loopback only
trayambak web --token mysecret     # require Authorization: Bearer mysecret
```

The process stays in the foreground until you stop it (the CLI keeps the event
loop alive after `listen`).

| Input | Where it comes from                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- |
| Port  | `--port` → else **8787** (`TRAYAMBAK_SERVER_PORT` is read by `startServer()` when no port option is passed, e.g. library use) |
| Host  | `--host` → else `127.0.0.1`                                                                                                   |
| Token | `--token` → else `TRAYAMBAK_WEB_TOKEN`                                                                                        |

## Endpoints

| Method + path       | Behaviour                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- |
| `GET /health`       | `{"status":"ok","model":"<configured model>"}` — always `200`, never requires the token |
| `GET /openapi.json` | OpenAPI 3.0 spec (`{"info":{"title":"Trayambak Agent API","version":"0.5.0"}}`)         |
| `GET /v1/models`    | `{"data":[{"id":"<configured model>"}]}`                                                |
| `GET /api/sessions` | `{"sessions":[…]}` — the transcript index (see [Sessions](sessions.md))                 |
| `POST /v1/agent`    | Runs the agent, streams **SSE** events                                                  |
| anything else       | `404 {"error":"not found"}`                                                             |

### `POST /v1/agent`

Request body:

```json
{ "prompt": "explain this repository", "sessionFile": "optional.json" }
```

- Missing/blank `prompt` → `400 {"error":"missing 'prompt'"}`.
- On success the response is `text/event-stream`; each agent event is one
  `data: <json>` frame, the stream ends with `data: [DONE]`.
- A run failure is reported in-band as `data: {"error":"…"}`.

```sh
curl -N http://127.0.0.1:8787/v1/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mysecret" \
  -d "{\"prompt\":\"say hello in one word\"}"
```

## Authentication

```sh
set TRAYAMBAK_WEB_TOKEN=mysecret
trayambak web
curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer mysecret"
```

- With a token configured, **every route except `/health`** requires
  `Authorization: Bearer <token>`; anything else gets
  `401 {"error":"unauthorized"}`.
- **Without a token there is no authentication at all.** The default host is
  `127.0.0.1` (loopback only) — do not pass `--host 0.0.0.0` without a token.

## CORS

The server always sends:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type, Authorization
```

and answers `OPTIONS` preflight requests with `204`. That makes browser pages
on your machine able to call the API — another reason to keep it on loopback
or set a token.

## What it runs on

Each `POST /v1/agent` builds an `Agent` from your normal `loadConfig()` — same
provider, tools, permissions, and sandbox as the CLI — and captures events
into the telemetry sink created with `createTelemetry(false)`, which is a
`NullTelemetry` (nothing is recorded by default). See
[Security](security.md).

## Example: script against the API

```sh
# 1. health (token-free)
curl http://127.0.0.1:8787/health

# 2. what sessions exist?
curl http://127.0.0.1:8787/api/sessions -H "Authorization: Bearer $TRAYAMBAK_WEB_TOKEN"

# 3. run one prompt, print the SSE stream
curl -N http://127.0.0.1:8787/v1/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TRAYAMBAK_WEB_TOKEN" \
  -d '{"prompt":"run the test suite and summarise failures"}'
```

## Related

- [Sessions](sessions.md) — what `/api/sessions` returns.
- [ACP](acp.md) — the stdio alternative for editors.
- [Security](security.md) — token handling and network exposure.
- [Troubleshooting](troubleshooting.md) — `401` from the web server.
