# Security Policy

## Supported versions

| Version | Supported               |
| ------- | ----------------------- |
| 1.2.x   | Yes — latest patch only |
| 1.1.x   | Security fixes only     |
| < 1.1   | No — please upgrade     |

Security fixes ship as patch releases. `npm run sbom` emits
`sbom.cyclonedx.json`; npm publishes use `--provenance` for
supply-chain attestation.

## Reporting a vulnerability

- **Open a GitHub issue directly** at
  <https://github.com/SHRIJANAGAIN/Nemo-Cli/issues> — there is no private
  reporting channel. Include the affected version, reproduction steps,
  impact, and logs.
- Redact secrets before posting: `NEMO_API_KEY`, `NVAPI_*` keys, OAuth
  tokens and anything from `~/.nemo/mcp-auth.json`. Never paste a live
  key into an issue — rotate it if it was ever exposed.
- Expect an acknowledgement within **3 business days** and a fix
  timeline within **14 days** for confirmed High/Critical issues.

## Scope

In scope: CLI command injection via tools, path traversal outside
`cwd`, MCP OAuth token handling, auto-update integrity, secret
handling in `config.json` / `mcp-auth.json` / env vars.
Out of scope: social engineering, physical access, upstream provider
breaches, findings requiring a rooted/jailbroken host.

## Local-first data handling

Nemo can run a local model through llama.cpp — no prompts or code
leave the machine unless you configure a remote provider (`baseUrl`,
`apiKey`) or remote MCP server. There is no telemetry: no usage, crash or
performance data is collected or transmitted.

Review before running untrusted prompts:

- binary path `NEMO_LLAMACPP_BIN` and GGUF model source,
- working directory (`NEMO_CWD` / `--cwd`),
- MCP servers (`NEMO_MCP_SERVERS`), hooks, and skills.

## Secret storage

- API keys: prefer env vars (`NEMO_API_KEY`) over `config.json`.
  `config.json`, `sessions.json`, transcripts, and `mcp-auth.json` are
  written with `0600` permissions (POSIX) and atomically (tmp + rename).
- `~/.nemo/mcp-auth.json` holds OAuth tokens — never commit it,
  never paste it into issues. `nemo mcp logout <name>` deletes the
  local tokens for that server.
- Keys pasted with prefixes (`NVAPI_KEY …`, `Bearer …`, `KEY=…`) are
  stripped at load but still stored clean — rotate a key that was ever
  committed or screenshared.
- OS keychain integration is not yet built in; on shared hosts set
  `NEMO_API_KEY` per-process and keep `~/.nemo/` `0700`.

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
- `NEMO_SKIP_OBFUSCATION=1` (or `--skip-obfuscation`) produces a debuggable publish build;
  default obfuscation is size/hygiene only — never a security boundary.
- Verify the tarball contains only `dist/` + `Img/` (`files` allowlist).
