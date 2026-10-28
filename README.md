# Nemo CLI

**NEMO** is an AI coding agent that runs on your computer. Built by **Shrijan Kumar Tiwari**, it lives in your terminal and helps you carry out software development tasks: reading and modifying code, running shell commands, searching files, fetching web pages, and autonomously planning and adjusting its next steps based on feedback as it works.

Licensed under the **Apache License 2.0**. Open source, developed and maintained by Shrijan.

---

## Demo

Watch the short animated walkthrough of nemo in action:

[![Nemo CLI Demo](https://img.youtube.com/vi/XqzXESMbUKg/0.jpg)](https://www.youtube.com/watch?v=XqzXESMbUKg)

---
View or download the video on GitHub:
https://www.youtube.com/watch?v=XqzXESMbUKg



---

## What is nemo?

NEMO is a terminal-based AI agent for autonomous software development. It fits scenarios such as:

- Writing and modifying code — implementing features, fixing bugs, completing refactors
- Understanding a project — exploring an unfamiliar codebase and answering questions about architecture and implementation
- Automating tasks — batch-processing files, running builds and tests, chaining scripts together
- Hunting vulnerabilities — nemo hunts bugs like it wants them dead

The CLI is written in TypeScript, distributed via npm, and runs on Node.js >= 18. It brings your own provider: NVIDIA NIM, Ollama, llama.cpp, or any OpenAI-compatible endpoint. Run fully locally with Ollama or llama.cpp for zero provider network traffic.

---

## Features

| Feature | Description |
| ------- | ----------- |
| Interactive TUI | Ink-based React terminal UI with streaming output, tool-call visualization, plan mode, and animations |
| Slash commands | /newchat, /sessions, /model, /provider, /compact, /fork, /help, /keymap, and more |
| CLI subcommands | nemo run "prompt", nemo exec "prompt", nemo review, nemo commit, nemo stats, nemo doctor, nemo web, nemo serve, and many more |
| Keyboard shortcuts | Esc, Ctrl-C, Ctrl-S, Ctrl-O, Ctrl+K, Ctrl+P, Ctrl+Z/Y, Ctrl+G/B, Ctrl+X, Ctrl+D |
| Multi-agent | nemo__ParallelReview, nemo__ParallelExecute, subagents, fork, tasks, and swarms |
| Skills | Bundled specialist subagent personas for architecture, language-specific review, build resolution, security auditing, refactoring |
| Memory and checkpoints | Session history, workspace checkpoints (undo/redo), mistake memory, and evals |
| Sandbox and policy | OS-level sandbox where available; policy-only on Windows and unknown platforms; deny-first exec policy |
| Audit trail | Tamper-evident, hash-chained audit log |
| Docker | Multi-stage production image, unprivileged node user, health check |
| Privacy | No product telemetry; local models keep prompts on your own machine |

---

## Get Started

### 1. Install

```sh
npm install -g @shrijanagain/nemo-cli
```

Or build from source:

```sh
git clone <repo>
cd nemo
npm install
npm run build
```

### 2. Launch

```sh
nemo
```

### 3. Connect a provider

```sh
/provider
```

Supports nvidia, nvidia-nim, ollama, llamacpp, and custom.

### 4. Choose a model

```sh
/models
```

---

## Usage

### Session commands

| Command | Description |
| ------- | ----------- |
| /newchat | Start a new session, clearing the current context (/clear does the same) |
| /sessions | Browse session history and choose one to resume |
| /model | Switch the current model |
| /provider | Pick a backend, save its key, and switch models |
| /compact | Manually compress the context to free up tokens |
| /fork | Fire-and-forget background subagent with this turn's context |
| /help | List all built-in slash commands |
| /keymap | Show every keyboard shortcut |

### Most-used keyboard shortcuts

| Shortcut | Description |
| -------- | ----------- |
| Esc | Interrupt streaming output or close a popup |
| Ctrl-C | Interrupt output; press twice while idle to exit |
| Shift-Tab | Toggle Plan mode |
| Ctrl-S | Inject the current draft to the front of the queue, mid-stream |
| Ctrl-O | Collapse or expand tool output and compaction summaries |
| Ctrl+K | Leader key — opens the which-key overlay with all shortcuts |
| Ctrl+P | Command palette |
| Ctrl+Z / Ctrl+Y | Undo or redo a workspace checkpoint |
| Ctrl+G / Ctrl+B | Subagents panel or background tasks panel |
| Ctrl+X | Clear queued prompts |
| Ctrl+D | Abort the current turn |

### CLI command reference

Run `nemo help` for the authoritative list:

| Command | Description |
| ------- | ----------- |
| nemo | Start an interactive session |
| run "prompt" | Interactive session that runs that prompt immediately |
| exec "prompt" | Headless run — newline-delimited JSON events on stdout |
| review [target] | Review code or changes for bugs, security issues, style |
| commit [--staged|--all] | Draft a conventional-commit message for the diff |
| stats | Show usage stats (sessions, events, violations) |
| doctor | Diagnose the local environment |
| info | Runtime and config summary |
| web [--port 8787] | HTTP agent API plus /api/sessions plus /openapi.json |
| serve [--port 8080] | Start a local llama.cpp server |
| download <org/model> | Download a GGUF model |
| acp | Run as an ACP agent server (stdio JSON-RPC) |
| login [--with-api-key K|status] / logout | Store or delete credentials |
| upgrade [version] | Update nemo (git/npm) and rebuild |
| config get [key] / config set <k> <v> | Show or persist configuration |

Global flags: --base-url <url>, --model <name>, --provider <name>, --cwd <dir>, --session <file>, --port <n>, --host <addr>, --dev, --version/-v, --help/-h. Shorthands: -p prompt, -m model, -c cwd; --no-<flag> sets a flag to false.

---

## Providers and Models

Bring your own NVIDIA NIM key (nvapi-… from build.nvidia.com) for the hosted backend, or run fully locally with Ollama or llama.cpp for a session with no provider network traffic at all. custom points nemo at any other OpenAI-compatible endpoint you run yourself.

---

## Configuration

Config file: ./.nemo/config.json when a .nemo/ directory exists in the current directory, otherwise ~/.nemo/config.json. Written atomically with 0600 permissions and a .bak rotation. Schema: [config.schema.json](config.schema.json).

Precedence (lowest to highest): built-in defaults < config file < NEMO_* environment variables < CLI flags.

```sh
nemo config get              # dump every effective value
nemo config get model        # one value
nemo config set model nvidia/nemotron-3-super-120b-a12b
nemo config set provider nvidia
```

| Variable | Sets |
| -------- | ---- |
| NEMO_BASE_URL | Provider base URL |
| NEMO_MODEL | Model id |
| NEMO_SMALL_MODEL | Cheap model for background chores (auto-titles) |
| NEMO_SUBAGENT_MODEL | Default model for subagent children |
| NEMO_API_KEY | API key (beats the config file) |
| NEMO_PROVIDER | Provider id |
| NEMO_CWD | Working directory for tools |
| NEMO_CONTEXT_WINDOW | Context window driving compaction |
| NEMO_MCP_SERVERS | MCP servers as JSON |
| NEMO_WEB_TOKEN | Bearer token for nemo web |
| NEMO_WEB_ORIGINS | Extra browser origins for nemo web (* = any) |
| NEMO_AUTOUPDATE | true / false / notify |
| NEMO_DISABLE_AUTOUPDATE | Auto-update kill switch |
| NEMO_MOTION | Animation level: off / reduced / full |
| NEMO_REDUCED_MOTION | 1 for reduced motion when NEMO_MOTION unset |
| NEMO_GLYPHS | ascii / unicode marks and box drawing |
| NEMO_SPINNER | Spinner style (braille, line, arc, meter, …) |
| NEMO_IDLE_ANIM | 1 to breathe the footer/composer while idle |
| NEMO_BOOT_CINE | 1 to replay the boot cinematic in this shell |

---

## Docker

```sh
docker build -t nemo .
docker run -it --rm nemo --help
```

The image is multi-stage, builds on node:20-slim, and runs as the unprivileged node user. A health check hits http://127.0.0.1:8787/health (overridable via HEALTHCHECK flags).

---

## Development

```sh
npm install          # install dependencies
npm run build        # compile TypeScript (main tree plus Ink UI)
npm run typecheck    # type-check without emit
npm test             # run vitest suite
npm run lint         # eslint
npm run format:check # prettier check
```

Run the CLI from compiled output:

```sh
node dist/apps/cli/src/index.js --help
```

With shims installed (node scripts/install-global.js), plain nemo works too.

### Project structure

- apps/cli — CLI entry, subcommands, flags, session commands
- apps/runtime — config loader, agent loop, tools, prompts, auto-update
- apps/vscode-extension — VS Code extension
- packages/* — protocol, provider adapters, TUI (Ink), MCP, ACP, server, SDK, sandbox, session backends, coding-agent, harness, core, checkpoints, modes, and more
- nemo/ — numbered internal subsystems (mistake memory, evals, memory, control, healing, hooks)

See [AGENTS.md](AGENTS.md) for coding conventions and layout notes, and [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution guide.

---

## Troubleshooting

Something not working? Start with the built-in doctor:

```sh
nemo doctor   # Node, config, model, llama.cpp binary, endpoint reachability
nemo info     # version, node, platform, cwd, baseUrl, model, shell
```

---

## Security and Privacy

nemo supports local models (ollama, llamacpp), which is the strongest privacy option — prompts go only to your own machine. There is no product telemetry: no usage, crash, or performance data is collected.

The agent has a single tool-approval decision point, a deny-first exec policy, OS-level sandboxing where available, and a tamper-evident, hash-chained audit log.

---

## License

nemo Code is open source software developed and maintained by Shrijan, licensed under the Apache License 2.0 — see [LICENSE](LICENSE) for the full terms. You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of it, including for commercial purposes, under the terms of that licence.


---
<div align="center">
  <p><b>Built with ❤️ in India and 2 months of hard work.</b></p>
</div>
                                                  
