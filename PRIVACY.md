# Privacy Policy — Trayambak CLI

Effective: 2026-09-28. Contact: SKT AI LABS security contact (see SECURITY.md).

- Keys stay local: `~/.trayambak/credentials.json` (0600) or `TRAYAMBAK_API_KEY` env. Never committed.
- Prompts go only to your configured provider (`baseUrl`). Local llama.cpp = no network.
- Telemetry off by default (`NullTelemetry`). Debug telemetry only with explicit opt-in; no code/prompts/keys leave the machine.
- MCP OAuth tokens: `~/.trayambak/mcp-auth.json` (0600). `mcp logout <name>` deletes them.
- Opt-out: unset `TRAYAMBAK_TELEMETRY`, delete `~/.trayambak/` to wipe local state.
