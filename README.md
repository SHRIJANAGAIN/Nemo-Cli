**Nemo CLI** is a coding agent from Shrijan that runs locally on your computer

## **What is Nemo CLI ?**

**Nemo CLI** is an AI agent that runs in the terminal, helping you carry out software development tasks and day-to-day terminal operations — reading and modifying code, running shell commands, searching files, fetching web pages, and autonomously planning and adjusting its next steps based on feedback as it works.

_It fits scenarios such as:_

- Writing and modifying code: implementing new features, fixing bugs, completing refactors

- Understanding a project: exploring an unfamiliar codebase and answering questions about architecture and implementation

- Automating tasks: batch-processing files, running builds and tests, chaining multiple scripts together

- Nemo hunts bugs like it wants them dead

- The CLI is written in TypeScript, distributed via npm, and runs on Node.js

## **What's New & Different From The Rest ?**

We Run Bug-Hunting On An **Inversion** Discipline Rather Than A Bigger Model

_The method is in the code, not just the copy: `buildInversionDirective()` in [apps/runtime/src/prompt/power-prompt.ts](apps/runtime/src/prompt/power-prompt.ts) is injected into the system prompt every turn — name the failure mode before touching files, ship the test that could disprove the claim, run the adversarial case first. What that buys you is a much better *bug-hunter*, not a guarantee that every class of vulnerability gets found: coverage still depends on the model you point it at and the surface you let it touch._

---

|           ![Bug-hunter subagent is born — inversion thinking, permission gate up](https://skt.sktailabs.in/img/IM1.png)            | ![The hunt, live — 11 toolcalls deep, session rules holding](https://skt.sktailabs.in/img/IM2.png) |
| :--------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------: |
| _Here's the moment the bug-hunter subagent spins up — it flips the problem around and asks for permission before it does anything_ |   _A few Seconds into a real hunt: 11 tool calls in, and the session rules haven't slipped once_   |

> **What's the actual difference?**
>
> Most agents try to tell you things will work. We'd rather find out where they don't.
>
> So instead of asking "will this run?", Nemo asks "how does this break?" — and then sits down and proves it can't.
>
> It sounds simple, but it changes everything about how the agent works:
>
> 1. **We flip the problem first.** Before writing a single line, we ask what would make this fail — and reason backwards from there.
> 2. **We break it before we fix it.** No patch goes in until we've watched it go wrong ourselves. If we can't reproduce it, we don't touch it.
> 3. **Nothing gets a free pass.** Every claim the agent makes gets checked. If it can't show its work, it doesn't get to say it.
> 4. **It just talks like a person.** No buzzwords, no vague hand-waving — you get a straight answer you can actually read.

---

## Get Started

1. **Install Nemo CLI**

Windows (PowerShell):

```
irm https://skt.sktailabs.in/install.ps1 | iex
```

macOS / Linux:

```
curl -fsSL https://skt.sktailabs.in/install.sh | bash
```

Or directly with npm (all platforms):

```
npm install -g @shrijan/nemo-cli
```

2. How To **Launch** The **CLI**

Type `nemo` or `nemo` in your terminal:

```
nemo
```

3. **Connect** With Any **Provider**

Type `/provider` and connect with any provider:

```
/provider
```

4. Choose A **Model**

Type `/models` and pick one from the list:

```
/models
```

_Use **Nemo** to hunt **vulnerabilities** — or to **build**._

---

## Common commands and keyboard shortcuts

_For a **first-time user**, the following is all you need to know:_

**Session commands**

| Command     | Description                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `/newchat`  | Start a new session, clearing the current context (`/clear` does the same)                     |
| `/sessions` | Browse session history and choose one to resume                                                |
| `/model`    | Switch the current model                                                                       |
| `/provider` | Pick a backend, save its key, and switch models                                                |
| `/compact`  | Manually compress the context to free up tokens                                                |
| `/fork`     | Fire-and-forget background subagent with this turn's context (you stay in the current session) |
| `/help`     | List all built-in slash commands                                                               |
| `/keymap`   | Show every keyboard shortcut                                                                   |

> Session forking (an independent copy with full history) is the **`F` key**
> inside the `/sessions` picker — along with `r` rename, `d` delete and
> `Ctrl+A` archive.

**Most-used keyboard shortcuts**

| Shortcut            | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `Esc`               | Interrupt streaming output / close a popup                     |
| `Ctrl-C`            | Interrupt output; press twice while idle to exit               |
| `Shift-Tab`         | Toggle Plan mode                                               |
| `Ctrl-S`            | Inject the current draft to the front of the queue, mid-stream |
| `Ctrl-O`            | Collapse / expand tool output and compaction summaries         |
| `Ctrl+K`            | Leader key — opens the which-key overlay with all shortcuts    |
| `Ctrl+P`            | Command palette                                                |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo a workspace checkpoint                             |
| `Ctrl+G` / `Ctrl+B` | Subagents panel / background tasks panel                       |
| `Ctrl+X`            | Clear queued prompts                                           |
| `Ctrl+D`            | Abort the current turn                                         |

---

## Command line reference

Run `nemo help` for the authoritative list:

| Command                                           | Description                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `nemo`                                       | Start an interactive session (alias: `nemo`)                                                       |
| `run "prompt"`                                    | Interactive session that runs that prompt immediately (headless JSON events when stdout is piped) |
| `exec "prompt"`                                   | Headless run — newline-delimited JSON events on stdout                                            |
| `git diff \| nemo exec "review"`             | Piped stdin becomes model context (capped, instruction first)                                     |
| `review [target]`                                 | Review code/changes for bugs, security issues, style                                              |
| `commit [--staged\|--all]`                        | Draft a conventional-commit message for the diff                                                  |
| `stats`                                           | Show usage stats (sessions, events, violations)                                                   |
| `pr <checkout\|link\|unlink\|status>`             | Pull-request helpers via `gh`                                                                     |
| `db <path\|summary\|threads\|violations>`         | Inspect the local state store                                                                     |
| `uninstall`                                       | Remove launcher shims (keeps config/sessions/state)                                               |
| `config get [key]` / `config set <k> <v>`         | Show / persist configuration                                                                      |
| `doctor`                                          | Diagnose the local environment                                                                    |
| `info`                                            | Runtime & config summary                                                                          |
| `agent [list\|info\|run]`                         | Manage agent profiles                                                                             |
| `task [list\|create]`                             | Manage nemo tasks                                                                            |
| `todo [list\|add\|update]`                        | Manage session todos                                                                              |
| `plan [create\|list\|show]`                       | Manage multi-step plans                                                                           |
| `manager [status\|summary]`                       | Show manager status                                                                               |
| `compact [config\|estimate\|run\|reset]`          | Configure/run session compaction                                                                  |
| `mode [list\|current\|set]`                       | Switch operating modes                                                                            |
| `worktree [list\|create\|remove\|switch]`         | List/switch git worktrees                                                                         |
| `mcp [list\|auth\|logout\|status]`                | Manage MCP servers & OAuth                                                                        |
| `marketplace <list\|search\|install\|remove>`     | Browse/install shareable skills & agents                                                          |
| `upgrade [version]`                               | Update nemo (git/npm) and rebuild                                                            |
| `serve [--port 8080]`                             | Start a local llama.cpp server                                                                    |
| `download <org/model>`                            | Download a GGUF model                                                                             |
| `acp`                                             | Run as an ACP agent server (stdio JSON-RPC)                                                       |
| `web [--port 8787]`                               | HTTP agent API + `/api/sessions` + `/openapi.json`                                                |
| `login [--with-api-key K\|status]` / `logout`     | Store or delete credentials                                                                       |
| `archive <id>` / `unarchive <id>` / `delete <id>` | Manage saved sessions                                                                             |
| `mcp-server`                                      | Run an MCP server (tools over stdio)                                                              |
| `sandbox check <file>`                            | Check the sandbox policy for a file                                                               |
| `execpolicy check <cmd>`                          | Check the exec policy for a command                                                               |
| `resume <id>`                                     | Resume a stored session                                                                           |
| `export [id] [--format markdown\|json\|text]`     | Export a session transcript (default `markdown`)                                                  |
| `completion <bash\|zsh\|fish\|powershell>`        | Print a shell completion script to source from your profile                                       |

**Global flags:** `--base-url <url>`, `--model <name>`, `--provider <name>`
(`nvidia`, `nvidia-nim`, `ollama`, `llamacpp`, `custom`), `--cwd <dir>`,
`--session <file>`, `--port <n>`, `--host <addr>`, `--dev`,
`--version`/`-v`, `--help`/`-h`. Shorthands: `-p` prompt, `-m` model,
`-c` cwd; `--no-<flag>` sets a flag to `false`.

---

## Models

Bring your own NVIDIA NIM key (`nvapi-…` from build.nvidia.com) for the hosted
backend, or run fully locally with `ollama` / `llamacpp` for a session with no
provider network traffic at all. `custom` points Nemo at any other
OpenAI-compatible endpoint you run yourself.

## Configuration reference

Config file: `./.nemo/config.json` when a `.nemo/` directory exists
in the current directory, otherwise `~/.nemo/config.json` — written
atomically with `0600` permissions and a `.bak` rotation. Schema:
[`config.schema.json`](config.schema.json).

**Precedence (lowest → highest):** built-in defaults < config file <
`NEMO_*` environment variables < CLI flags.

```sh
nemo config get              # dump every effective value
nemo config get model        # one value
nemo config set model nvidia/nemotron-3-super-120b-a12b # persist (numbers/booleans coerced)
nemo config set provider nvidia
```

**Key environment variables** (full list in
[docs/getting-started.md](https://skt.sktailabs.in/docs/getting-started.md#configuration)):

| Variable                       | Sets                                                  |
| ------------------------------ | ----------------------------------------------------- |
| `NEMO_BASE_URL`           | Provider base URL                                     |
| `NEMO_MODEL`              | Model id                                              |
| `NEMO_SMALL_MODEL`        | Cheap model for background chores (auto-titles)       |
| `NEMO_SUBAGENT_MODEL`     | Default model for subagent children                   |
| `NEMO_API_KEY`            | API key (beats the config file)                       |
| `NEMO_PROVIDER`           | Provider id                                           |
| `NEMO_CWD`                | Working directory for tools                           |
| `NEMO_CONTEXT_WINDOW`     | Context window driving compaction                     |
| `NEMO_MCP_SERVERS`        | MCP servers as JSON                                   |
| `NEMO_WEB_TOKEN`          | Bearer token for `nemo web`                      |
| `NEMO_WEB_ORIGINS`        | Extra browser origins for `nemo web` (`*` = any) |
| `NEMO_AUTOUPDATE`         | `true` / `false` / `notify`                           |
| `NEMO_DISABLE_AUTOUPDATE` | Auto-update kill switch                               |
| `NEMO_MOTION`             | Animation level for this run: `off`/`reduced`/`full`  |
| `NEMO_REDUCED_MOTION`     | `1` for reduced motion when `NEMO_MOTION` unset  |
| `NEMO_GLYPHS`             | `ascii` / `unicode` marks and box drawing             |
| `NEMO_SPINNER`            | Spinner style (`braille`, `line`, `arc`, `meter`, …)  |
| `NEMO_IDLE_ANIM`          | `1` to breathe the footer/composer while idle (the welcome screen does) |
| `NEMO_BOOT_CINE`          | `1` to replay the boot cinematic in this shell        |

`off` installs no animation timer at all and paints each widget's finished
frame; `reduced` draws the line at position rather than speed — anything that
travels across the screen stops, anything that only changes brightness keeps
breathing. Readouts that show a real quantity — elapsed seconds, token counts —
are never frozen by either level. Switch it live with `/motion`, which saves the
level to config so the next start comes up the same way; the environment
overrides above win for the run that sets them, and are never written back.

`/spinner` picks the frame set the spinners cycle through and saves it the same
way. It lists every style with its frames painted, because the style you need is
the one your font cannot draw, and you cannot see that from a name.

---

## Exit codes

| Code | Meaning                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success — including `--help`, `--version`, and `config` usage output                                                                                                |
| `1`  | Failure — unhandled exception (logged to the mistake journal first), failed `doctor` checks, MCP CLI errors                                                         |
| `2`  | Usage error — unknown command, unknown `help` target, missing argument (e.g. `resume <id>`), unknown/missing flag, invalid `--port`, `--format`, or `--shell` value |
| `3`  | Policy denial — `execpolicy check <command>` matched a deny rule (CI-gatable: non-zero means blocked)                                                               |

The constants live in [`apps/cli/src/command-registry.ts`](apps/cli/src/command-registry.ts)
as `EXIT_OK` / `EXIT_ERROR` / `EXIT_USAGE` / `EXIT_DENIED` (3 = policy denial); usage failures are raised as
`EarlyExit(2)` from `usageAbort()` in [`apps/cli/src/index.ts`](apps/cli/src/index.ts).
The `mcp` subcommand follows the same scheme: usage failures (unknown
action, missing server name) exit `2`; operational failures (OAuth flow
errors, config problems) exit `1` (`apps/cli/src/commands/mcp.ts`).

---

## Architecture overview

Nemo is a TypeScript monorepo that compiles to `dist/` and ships on npm
as `@shrijan/nemo-cli` (bins `nemo` and `nemo`):

- **`apps/cli`** — the CLI entry: subcommands, flags, session commands.
- **`apps/runtime`** — the agent: config loader, agent loop, tools, prompts,
  auto-update.
- **`packages/*`** — protocol types, provider adapters (5 backends), the Ink
  TUI, MCP client/server, ACP, HTTP server, SDK, sandbox, session backends.
- **`nemo/`** — internal numbered subsystems: mistake memory, eval loop,
  memory, control, healing, hooks.

The build runs `tsc` (main), `tsc -p tsconfig.ink.json` (the Ink UI as ESM),
then an asset-copy + `fix-esm-imports.js` flatten step. Full walkthrough:
[docs/architecture.md](https://skt.sktailabs.in/docs/architecture.md).

---

## Troubleshooting

Something not working? Start with the built-in doctor:

```sh
nemo doctor   # Node, config, model, llama.cpp binary, endpoint reachability
nemo info     # version, node, platform, cwd, baseUrl, model, shell
```

Then see **[docs/troubleshooting.md](https://skt.sktailabs.in/docs/troubleshooting.md)** for the usual
suspects — 401s and prefixed keys, Ollama not running, a missing llama.cpp
binary, the wrong config file, web-server 401s, MCP timeouts, and stale
builds.

---

## Bug reporting

Found a bug? Reports that follow this flow get fixed fastest:

1. **Security vulnerability? Stop — report privately.** Do not open a
   public issue. Report directly to support@sktailabs.in
   with: affected version, reproduction steps, impact, and logs with
   secrets redacted ([SECURITY.md](SECURITY.md): acknowledgement within
   3 business days, fix timeline within 14 days for confirmed
   High/Critical, 90-day coordinated-disclosure window).
2. **Regular bug? Open a public issue** at
   <https://github.com/shrijan/nemo-cli/issues> with:
   - Title + severity (`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`)
   - Version and platform (`nemo info`: version, node, platform)
   - Minimal reproduction steps and minimal repro input
   - Expected vs actual behaviour, with evidence (output, logs)
   - Secrets redacted from everything you paste — never paste tokens,
     `0600` files, or `mcp-auth.json` contents

Triage is severity-first: crash, data-loss, and security-adjacent
`CRITICAL`–`HIGH` reports jump the queue, and anything with a failing
reproduction beats a description-only report.

---

## Documentation

| Doc                                                                 | Contents                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Getting started](https://skt.sktailabs.in/docs/getting-started.md) | Install, first session, subcommands, flags, config, env vars     |
| [Sessions](https://skt.sktailabs.in/docs/sessions.md)               | Transcript storage, resume/fork/archive, compaction, checkpoints |
| [Providers](https://skt.sktailabs.in/docs/providers.md)             | The 5 backends, key handling, local models                       |
| [MCP](https://skt.sktailabs.in/docs/mcp.md)                         | MCP servers, OAuth, connector registry, `mcp-server`             |
| [ACP](https://skt.sktailabs.in/docs/acp.md)                         | Editor integration over stdio JSON-RPC                           |
| [Web](https://skt.sktailabs.in/docs/web.md)                         | Local HTTP agent API, SSE, token auth                            |
| [Security](https://skt.sktailabs.in/docs/security.md)               | Permissions, sandbox, secret storage                             |
| [Troubleshooting](https://skt.sktailabs.in/docs/troubleshooting.md) | Diagnosis and fixes                                              |
| [Architecture](https://skt.sktailabs.in/docs/architecture.md)       | Monorepo layout, build pipeline, CI                              |
| [Docs index](https://skt.sktailabs.in/docs/README.md)               | Quick reference for everything above                             |

---

## Security

Found a vulnerability? **report it privately — do not open a public issue.**
[SECURITY.md](SECURITY.md) has the reporting process, supported versions, scope,
and disclosure window; send it to support@sktailabs.in. Highlights: secrets are
stored `0600` and
atomic, there is no telemetry at all, and destructive shell commands are
denied by default with writes asking for approval
([docs/security.md](https://skt.sktailabs.in/docs/security.md)).

**Licensing for devmode is open** — free of charge for an **individual
developer**, for security testing and hardening of infrastructure you own or are
authorised to test. Companies must contact us; that needs a plan.

One thing to know before you rely on that: the licence is **verified online, by
design**. Enabling developer mode POSTs your licence key plus a persistent
machine id to `https://skt.sktailabs.in` (`apps/runtime/src/license.ts`, override
with `NEMO_LICENSE_SERVER` or `licenseServerUrl` in config). If the server
is unreachable the unlock **refuses** rather than fails open. Developer mode is
the switch for all of it: with `/devmode` off, nothing is unlocked and none of
this traffic happens at all. Details in [PRIVACY.md](PRIVACY.md).

**Nemo** supports local models (`ollama`, `llamacpp`), which is the
strongest privacy option — prompts go only to your own machine. There is no
product telemetry: no usage, crash or performance data is collected. The
licence traffic above is the only thing that leaves the machine on this path.

---

## License

Nemo Code is **open source** software developed and maintained by
**Shrijan**, licensed under the **Apache License 2.0** — see
[LICENSE](LICENSE) for the full terms. You may use, copy, modify, merge,
publish, distribute, sublicense and sell copies of it, including for
commercial purposes, under the terms of that licence.

Parts of Nemo Code are derived from OpenAI Codex CLI under the Apache
License 2.0, and those parts stay under Apache-2.0.
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists them file by file,
alongside the licence terms of every other externally-derived component.
