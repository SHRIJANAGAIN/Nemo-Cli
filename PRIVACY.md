# Privacy Policy — Nemo CLI

Effective: 2026-09-28. Contact: Shrijan security contact (see SECURITY.md).

- Keys stay local: `~/.nemo/credentials.json` (0600) or `NEMO_API_KEY` env. Never committed.
- Prompts go only to your configured provider (`baseUrl`). Local llama.cpp = no network.
- No telemetry. The CLI collects and transmits no usage, crash or performance data. There is no telemetry sink, no analytics upload and no opt-in switch, because there is nothing to switch on.
- MCP OAuth tokens: `~/.nemo/mcp-auth.json` (0600). `mcp logout <name>` deletes them.
- Local state wipe: delete `~/.nemo/` to remove every local artefact.

## Licensing: the one path that does send data

The licence check talks to the licence server. That traffic is **not** telemetry
and is not controlled by any telemetry switch. It is real and it is on by
default whenever developer mode is on:

- **What leaves the machine.** Two HTTPS POSTs to the license server
  (`apps/runtime/src/license.ts`): `/license/verify` carries your licence key and
  a machine id, and `/license/activate` does the same while binding the key to
  that machine. No prompt, no code, and no scan target is included — the
  payload is the key, the machine id, and nothing else.
- **Where it goes.** `https://skt.sktailabs.in` unless you set
  `NEMO_LICENSE_SERVER` or `licenseServerUrl` in config, which is how you
  self-host or point elsewhere.
- **The machine id.** A random UUID minted once per install at
  `~/.nemo/machine-id` (`getMachineId()`, written `0600`). It is not derived
  from hardware, but it is a stable per-install identifier and it rides along
  with every licence request, which is what makes the licence machine-bound.
- **When it happens.** Only inside an explicit developer-mode session. With
  `/devmode` off, the unlock is refused locally before any network call — no
  key, no verification. Ordinary use of the CLI sends nothing to the licence
  server on this path.
- **No offline mode.** The licence is verified live by design; if the server is
  unreachable the unlock refuses rather than fails open. Expect connectivity to
  the license server as a requirement for developer mode, not an optional
  behaviour.

## Not covered by this policy

`nemo serve` / local model downloads fetch third-party binaries
(<https://github.com/ggml-org/llama.cpp>) into `bin/`. Provider endpoints, MCP
servers and web fetch are outside Nemo Code's privacy boundary — read their own terms;
your prompt content goes to whichever provider you configure.

## Correction to an earlier claim

Versions before this note said "no code/prompts/keys leave the machine" without
qualification. That was accurate for the removed telemetry path and inaccurate
for licence verification, which does send your licence key to a licence-server endpoint.
The qualification above is the current, correct statement.
