# Third-party notices

Nemo CLI is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).
That licence does not remove the rights third-party authors hold in theirs,
so every externally-derived part of this repository is listed here under its
own licence terms.

Section 1 is the material one and is compliant. Section 2 records a licensing
exposure that existed in this repository and was removed; it is kept here
because removal does not retroactively erase the derivation.

## 1. OpenAI Codex CLI (`codex-rs`) — Apache License 2.0

- Upstream: <https://github.com/openai/codex>
- Copyright 2025 OpenAI
- Licensed under the Apache License, Version 2.0
- Full licence text: [licenses/OPENAI-CODEX-APACHE-2.0.txt](licenses/OPENAI-CODEX-APACHE-2.0.txt)
- Upstream notice reproduced verbatim: [licenses/OPENAI-CODEX-NOTICE.txt](licenses/OPENAI-CODEX-NOTICE.txt)

The following modules were reimplemented in TypeScript against the design,
naming, flag surface and policy semantics of `codex-rs`. Each carries a
per-file attribution header pointing back to this document. Where a module is
described as mirroring a Rust path, that Rust path is the reference design.

- `packages/core/src/agents_md.ts`
- `packages/core/src/agent_communication.ts`
- `packages/core/src/agent_registry.ts`
- `packages/core/src/analytics.ts`
- `packages/core/src/extension_api.ts`
- `packages/core/src/hook_runtime.ts`
- `packages/core/src/process.ts`
- `packages/core/src/rollout_budget.ts`
- `packages/sandbox/src/network-policy.ts`
- `packages/sandbox/src/spawn.ts`
- `packages/sandbox/src/types.ts`
- `packages/tui/src/chatwidget/chat-widget.ts`
- `packages/tui/src/ui/footer-mode.ts`
- `packages/tui/src/ink-app/thinking-ribbon.ts`
- `packages/tui/src/ink-app/App.tsx` (diff-render and live-output call sites)
- `packages/tui/src/ink-app/ToolCallItem.tsx` (live-output shaping)
- `apps/runtime/src/tools/text/diff-render.ts`
- `apps/runtime/src/tools/types.ts` (protected-metadata model)
- `packages/tui/src/app/app-state.ts`, `packages/tui/src/app/events.ts`
- `packages/tui/src/bottom_pane/composer.ts`
- `packages/tui/src/ui/index.ts`, `packages/tui/src/ui/theme.ts`,
  `packages/tui/src/ui/color.ts`, `packages/tui/src/ui/footer-mode.ts`,
  `packages/tui/src/ui/key-hint.ts`, `packages/tui/src/ui/command-popup.ts`,
  `packages/tui/src/ui/approval-overlay.ts`, `packages/tui/src/ui/tool-palette.ts`

Apache-2.0 permits this. Section 4 of that licence is why this file exists and
why the per-file headers stay: redistributed derivative work must carry the
attribution, the licence copy, and the NOTICE contents. The CLI argument
surface (`exec`, `review`, `execpolicy check`, `sandbox check`, `login`,
`resume`, `archive`, `completion`, …), several configuration enum values
(`workspace-write`, `read-only`, `external-sandbox`, `danger-full-access`) and
the sandbox-detection environment marker were chosen to match Codex for
behavioural parity; that matching is derivative authorship, not independent
convergence.

Inherited from the Codex NOTICE: Codex itself includes code derived from
Ratatui (<https://github.com/ratatui/ratatui>), MIT-licensed, Copyright
(c) 2016-2022 Florian Dehau and Copyright (c) 2023-2025 The Ratatui
Developers. `packages/tui/src/chatwidget/` and `packages/tui/src/ui/` port
from that TUI layer, so the Ratatui notice travels with them.

## 2. Anthropic Claude Code — fork removed

This section documents a file that **no longer exists in the working tree**. It
is retained because the facts in it are part of this repository's history, and
because deleting a disclosure is not the same as resolving a licence.

- What was affected: `packages/nemo-ink/` — 164 source files, ~28,900
  lines, described in its own README as a "Forked Ink TUI runtime".
- Upstream product: Claude Code, copyright Anthropic. Not open source, not
  published as source, distributed as a minified bundle.
- Licence status at the time: **no permission, grant or fork agreement from
  Anthropic was on file in this repository.**
- Provenance markers the fork carried: `src/core/jediTermScrollFix.ts`
  ("ported from ant v2.1.132 Z2H (2244.js)"), `src/core/events/input-event.ts`,
  `src/theme/theme-types.ts` ("ant v2.1.140 palette refresh"), and telemetry
  event names using Anthropic's internal `tengu_` prefix. Every file also
  carried an SKT "All rights reserved" header, which contradicted being a fork.

Resolution: the fork was **deleted outright** rather than licensed or rewritten.
The audit that led to that decision found it was orphaned — the live terminal UI
(`packages/tui/`) renders with MIT-licensed `ink` from the npm registry, nothing
in `apps/` or the shipped `dist/`/`publish/` artifacts imported
`packages/nemo-ink/`, and its 8 tests exercised only the fork itself. It
was excluded from `tsconfig.json`, so it was never part of a build. Deletion
therefore removed the exposure instead of requiring a clean-room rewrite or a
permission grant.

Also removed with it: the `@claude-code/local-observability`,
`@claude-code/output` and `@claude-code/repl` packages under
`packages/nemo-ink/vendor/`. Those were original SKT-written stand-ins of
~36 KB — they contained no Anthropic code and carried no Anthropic notice, and
existed only so the fork's import specifiers resolved against a private registry
that returns E404.

Going forward, no code in this repository is derived from Claude Code. If a
Claude Code–derived file is ever reintroduced, this section must be reopened and
the provenance markers in it must be kept, not stripped: removing them would not
change anyone's rights and would convert an ambiguous situation into evidence of
intent to disguise it.

## 3. Harness² — Apache License 2.0

The recursive-harness engine in `packages/core/src/harness/` is adapted from
Harness², Copyright 2026 Google LLC, Apache-2.0. Attribution and the adaptation
note live in [packages/core/src/harness/NOTICE.md](packages/core/src/harness/NOTICE.md).
This project is not a Google product and is not endorsed by Google.

## 4. llama.cpp and LLVM OpenMP — prebuilt binaries

`bin/` (gitignored, downloaded on demand) caches prebuilt Windows binaries of
llama.cpp from <https://github.com/ggml-org/llama.cpp> (MIT) — `llama-server`,
`llama-cli`, `ggml*.dll` — used by `nemo serve` and `nemo download`,
plus the LLVM OpenMP runtime covered by `bin/LICENSE-LLVM-OpenMP` (Apache-2.0
with the LLVM exception). The `bin/` directory's own README explains which
files are third-party and which are Nemo shims. These binaries are not
distributed inside the npm package.

## 5. npm runtime dependencies

MIT or permissive-licensed packages installed from the registry, listed by
`npm ls --omit=dev`; source terms travel with each package in
`node_modules/<name>/LICENSE`. The notable ones for user-visible behaviour are
`ink` (MIT, the terminal renderer `packages/tui/` uses — see section 2 for why
this is the only Ink in the product), `react`
(MIT), `@modelcontextprotocol/sdk` (MIT), and the MCP/vendor SDKs under
`packages/`.

## 6. Relationship to LICENSE

`LICENSE` is the Apache License 2.0. Its section 4 already states that
third-party components stay under their own licences and points at attribution
files for details. This document is that pointer. Nothing in this repository's
own licensing narrows Apache-2.0 rights in the section 1 files — those parts
remain governed by Apache-2.0, and the per-file attribution headers stay
because they are what satisfies section 4.

Questions about this file: support@sktailabs.in.
