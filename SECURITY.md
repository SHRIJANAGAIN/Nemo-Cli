# Security Policy

## Supported versions

| Version | Supported               |
| ------- | ----------------------- |
| 0.6.x   | Yes — latest patch only |
| 0.5.x   | Security fixes only     |
| < 0.5   | No — please upgrade     |

Security fixes ship as patch releases. `npm run sbom` emits
`sbom.cyclonedx.json`; npm publishes use `--provenance` for
supply-chain attestation.

## Reporting a vulnerability

- **Do not open a public issue.** Report privately — directly to
  support@sktailabs.in — with: affected version, reproduction
  steps, impact, and logs with secrets redacted.
- Expect an acknowledgement within **3 business days** and a fix
  timeline within **14 days** for confirmed High/Critical issues.
- Coordinated disclosure: please allow a fix + release before public
  disclosure (default **90-day** window).

## Scope

In scope: CLI command injection via tools, path traversal outside
`cwd`, MCP OAuth token handling, auto-update integrity, secret
handling in `config.json` / `mcp-auth.json` / env vars.
Out of scope: social engineering, physical access, upstream provider
breaches, findings requiring a rooted/jailbroken host.

## Local-first data handling

Trayambak can run a local model through llama.cpp — no prompts or code
leave the machine unless you configure a remote provider (`baseUrl`,
`apiKey`) or remote MCP server. Telemetry is off by default
(`NullTelemetry`); debug telemetry requires explicit opt-in.

Review before running untrusted prompts:

- binary path `TRAYAMBAK_LLAMACPP_BIN` and GGUF model source,
- working directory (`TRAYAMBAK_CWD` / `--cwd`),
- MCP servers (`TRAYAMBAK_MCP_SERVERS`), hooks, and skills.

## Secret storage

- API keys: prefer env vars (`TRAYAMBAK_API_KEY`) over `config.json`.
  `config.json`, `sessions.json`, transcripts, and `mcp-auth.json` are
  written with `0600` permissions (POSIX) and atomically (tmp + rename).
- `~/.trayambak/mcp-auth.json` holds OAuth tokens — never commit it,
  never paste it into issues. `trayambak mcp logout <name>` deletes the
  local tokens for that server.
- Keys pasted with prefixes (`NVAPI_KEY …`, `Bearer …`, `KEY=…`) are
  stripped at load but still stored clean — rotate a key that was ever
  committed or screenshared.
- OS keychain integration is not yet built in; on shared hosts set
  `TRAYAMBAK_API_KEY` per-process and keep `~/.trayambak/` `0700`.

## Tool execution

Bash/file-edit tools run inside the configured `cwd` under permission
rules (`permissions.mode`, per-tool `allow/ask` patterns). Deny-by-default
for destructive commands (`rm -rf /`, `format`, `shutdown`, `sudo/su`)
and ask-by-default for writes. Audit `permissions` before `full-access`
/ `yolo` automation or browser automation.

## More detail

A walkthrough of the permission layers, sandbox policies/backends, and
network exposure lives in [docs/security.md](docs/security.md).

## Releases

- `npm publish ./publish --provenance` (see `scripts/make-publish.mjs`).
- `TRAYAMBAK_SKIP_OBFUSCATION=1` (or `--skip-obfuscation`) produces a debuggable publish build;
  default obfuscation is size/hygiene only — never a security boundary.
- Verify the tarball contains only `dist/` + `Img/` (`files` allowlist).
