# Changelog

All notable changes to trayambak are documented here. The format is based on keeping an
`Unreleased` section; released sections are immutable.

## [0.6.6]

- **Mouse scroll, direct like Codex**: the wheel drives the in-app history
  window itself (lifetime mouse reporting + anchored reading position), so
  generation never yanks a parked window back to live — no arrow-key
  middleman, no mode to enter. PageUp/PageDown still page for terminals
  whose mouse reports never arrive.

- **Chat render guards**: composer placeholder pinned to Trayambak's own
  ("Type a message…", stale Codex line can never return), chooser arrows
  proven end-to-end (Down+Enter picks the neighbour, not the top hit),
  transcript rows carry zero background colour, and the fixed 42-col
  sidebar stands down below 90 columns instead of squeezing the chat into
  wrapped slivers.
- **Out-of-range temperature falls back to default, not the wild edge**:
  a misconfigured 2.7 used to clamp to 2.0 (still near-gibberish, and an
  NVIDIA 400 on older builds) — now it lands on the safe deterministic
  default instead. (0.6.5 on npm was a stale bundle missing recent work;
  0.6.6 ships everything below in one clean release.)
- **Mistake penalties tune local samplers only**: the backend-blind
  penalty log piled +0.1s onto every provider until hosted calls carried
  wild temperatures. `getConfigOverrides` now takes the provider and drops
  penalties for hosted APIs (base control-mode values stay); ollama /
  llama.cpp keep the capped tuning.
- **Backend decision LLM for local runs** (`developerMode.localSupervisor`):
  a configured backend model (any BYOK id — your API judge) now DECIDES the
  penalty knobs (temperature / maxToolCalls / webSearchFirst /
  clarificationRequired / stepByStep) from the mistake log instead of the
  fixed heuristic — but ONLY when the primary model is a local sampler
  (ollama / llama.cpp) with devmode on. Consulted once per new-mistake
  turn (no new mistake = no paid request), bounded payload (last 10
  mistakes, 200-char descriptions), 15s default timeout. Fail-open on
  every path: unconfigured / unknown provider id / timeout / abort /
  malformed reply keeps the heuristic penalties. Decisions are absolute
  per key (they replace, never sum), temperature decisions rebuild the
  provider so they reach the wire, and boolean decisions mirror into
  config (system-prompt suffix + step-by-step loop). Unset
  provider/model = disabled.
- **Web search serves real links**: DuckDuckGo redirect URLs
  (`//duckduckgo.com/l/?uddg=…`) are resolved to destinations at parse
  time and printed in results, so the model can fetch pages directly.
- **Wiby joins the failover chain**: a keyless bot-friendly JSON search
  API behind DuckDuckGo — when DDG challenges, Wiby still answers.
- **Windows reaches real OS-level sandboxing** (AppContainer, backend
  `windows-restricted` / `SandboxType.WindowsRestrictedToken`): the
  spawn runs through a short-lived PowerShell shim + compiled helper that
  calls `CreateProcessW` with
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` — the child gets a
  dedicated AppContainer profile, Low integrity, no user SID, and a
  default-deny NTFS ACL; writable roots / cwd / scratch are granted `F`,
  profile reads `R`, deny paths explicit deny ACEs (deny beats allow),
  and network follows the policy through spawn-time capability SIDs
  (`internetClient` / `internetClientServer` /
  `privateNetworkClientServer`; no caps = kernel-dropped outbound). No
  admin rights required. stdio flows over inherited handles
  (`STARTF_USESTDHANDLES` crashes AC children with 0xC0000142, a custom
  `lpEnvironment` dies with error 203 — both verified), and exit codes
  survive child death because the spawn-time `hProcess` is held until
  read (a handle-less exited process object is destroyed instantly and
  the old post-mortem `OpenProcess` reported 1 for every command).
  Honesty is enforced: `windowsAcCapable()` claims only infrastructure,
  the per-spawn `status.json` handshake is the real gate, and any
  failure falls back to an unsandboxed spawn with `isSandboxed: false`
  instead of faking isolation. Windows stays truthful on the foreground
  marker: `[sandbox: os (windows_sandbox)]` only when the handshake
  proved it.
- **Windows sandbox grants are bounded, journaled, and fail closed**:
  security-descriptor writes are not uniformly fast — fresh directories
  answer in ~25ms, profile children take 0.1s–18s, and a directory whose
  write was killed mid-flight can wedge so that no writer (icacls or
  .NET) ever completes again until reboot. Every grant therefore runs
  under a per-path deadline inside a per-spawn budget, results are
  journaled for 24h so a converged machine does zero grant work, wedged
  branches expand into their children (one ungrantable directory never
  starves its subtree), and a skipped grant fails closed — the sandboxed
  child simply cannot touch that path, never a stalled handshake or a
  silently unsandboxed fallback.

## [0.6.5]

- **Welcome screen restored**: the boot GitHub notice put a system row into
  the transcript, and the old `messages.length === 0` check let that single
  row kill the WelcomeScreen (logo + Welcome) on every logged-in boot. The
  welcome now lives until the first real user/assistant exchange, with boot
  notices listed beneath it.
- **`/mcp` actually works now**: the old command only printed dead usage
  rows. New `mcp-command.ts` implements list/search/install/add/remove/test
  against the connector registry + live servers — every accepted change
  persists and rebuilds the agent with no restart, failed adds never touch
  config.
- **MCP/skill tools survive agent rebuilds**: `createAgentConfig` dropped
  `mcpServers`/`skillsDir`, so every rebuild produced an agent with zero
  MCP tools even when servers were configured. Same drop class as the
  earlier provider/developerMode/identity fixes.
- **System-prompt exfil lock + security trail**: `--dump-system-prompt`
  attempts are now stored as `prompt_exfil_attempt` events, and every
  pentest tool run/refusal is stored as `pentest_run` (tool, target,
  outcome, capped output) — append-only JSONL at `~/.trayambak/security.log`,
  redacted, never throwing.
- **Pentest tools honor devmode OFF**: the execution gate only checked the
  license, so a live trial key ran scans with developer mode OFF. The gate
  now refuses first on devmode OFF (offline-quiet, no network), then on
  license. Missing scanner binaries are refused up front with per-OS
  install guidance instead of a bare `spawn ENOENT`.
- **Boot cinematic**: returning users get a ~2.5s third-eye opening on
  every launch (any key skips, prompt-arg launches skip it) before the
  welcome screen.
- **Temperature clamped on every backend**: hosted providers already
  clamped to their ceilings, but llama.cpp sent the raw value — local
  servers accept anything, so 2.7 sailed through and the sampler melted
  into multilingual mush (and NVIDIA 400s anything over 2). Same 0–2
  ceiling everywhere now, config → provider both layers.

## [0.6.4]

- **Agent writes with your GitHub handle (no GITHUB_TOKEN paste)**: the
  license server now proxies repo writes with the stored `/github login`
  OAuth token — `POST /github/write`, `/github/branch`, `/github/pr`,
  `/github/copy`, plus `GET /github/repos` (your repo list). The agent's
  `github` tool rides them automatically when logged in
  (`write_file`/`create_branch`/`create_pr`/`copy_files` fall back to VPS,
  new `list_repos` action). The OAuth token itself still never leaves the
  server. Note: the authorize URL now requests `repo` scope, so existing
  logins must `/github logout` + `/github login` once for writes to work.
- **Operator identity survives restarts**: `createAgentConfig` dropped
  `githubLogin`/`licenseKey`/`licenseServerUrl`, so after a TUI restart the
  agent's `## OPERATOR` block read "not logged in" even with a live login.
- **Boot GitHub reconnect**: a saved login is verified once at startup —
  live connections announce (`connected as @x`) and seed the first turn;
  dead ones are cleared with a one-line re-login nudge instead of failing
  mid-task at the first write.

## [0.6.3]

- **Boot-time provider connect**: fresh installs (no API key anywhere) now
  open the provider chooser automatically — model selection up front,
  kimi-style. Esc drops back to welcome; configured users never see it.

## [0.6.2]

- Identical to 0.6.1 (which wedged in npm's "Validating" queue and could
  not be republished — "Cannot publish over previously staged version").
  Bumped to sidestep the stuck staging slot; use 0.6.2+.

## [0.6.1]

- **Fixed broken 0.6.0 bundle (P0, user-reported)**: the obfuscator's string
  array rewrote some `exports['name']` bindings to computed lookups, which
  Node's static export detection cannot see — so cross-file
  `import {name}` died at startup (`SessionPicker → backfillUntitledSessions`
  crashed every launch). Two systemic fixes, not a one-name patch:
  `scripts/make-publish.mjs` now reserves every module-linkage identifier per
  file (`reservedStrings`), and `scripts/verify-pack.mjs` has a module
  linkage gate proving every static import resolves (it fails the pack
  otherwise). 0.6.0 stays on npm for history; use 0.6.1+.

## [Unreleased]

### Changed — the terminal tab now says `Trayambak` and animates while working

- **The tab/window title is claimed on startup.** The shell keeps reporting its cwd as the title, so a trayambak tab read `engli` (or whatever folder) and gave no hint what was running. On mount the TUI now sets the title to the product name via OSC 0, then keeps an activity-aware title (`Trayambak - working`, `! Trayambak - approval needed`, …) as state changes — the existing `terminal-notify` port, now wired to claim the title instead of only reacting to activity.
- **Live animation while a turn runs**: the title cycles an ASCII spinner (`| / - \`) every 120 ms during load/streaming, showing background-subagent count and phase, then settles back to the static title when the turn ends, when an approval/error/input needs attention, and on unmount. Restart-safe (each start clears the previous timer) and `unref`'d so a cosmetic animation can never hold the process open.
- **ASCII-only frames on purpose**, matching the existing activity marks: a braille spinner renders as mojibake on non-UTF8 conhost tabs.
- **Never touches a pipe.** Writes stay gated on `stdout.isTTY` and `TRAYAMBAK_NO_NOTIFY=1`, and remain synchronous (`fs.writeSync`) so a title change cannot interleave with an Ink frame. Verified by driving the _shipped_ `dist` module with piped stdout: **0 bytes** emitted, no escape sequences at all.
- Title writes are deduplicated, and every emitted title is asserted free of control characters (a BEL/ESC inside the payload would terminate the OSC sequence early and spill raw bytes into the terminal).
- Tests: `terminal-notify.test.ts` extended (product name, animated-title builder, animation lifecycle, restart-without-leak, kill-switch, no-TTY), plus a new byte-level `terminal-title-bytes.test.ts` that captures the exact OSC 0 bytes and asserts the frame order `| / - \ |` and that nothing arrives after `stop()`. A pty-level check (`terminal-title-pty.test.ts`) is Unix-only and explicitly **skips** on Windows rather than silently passing without a pty.

### Fixed — the leak was still live in the _installed_ CLI, and the shims hid it

- **The patched repo was not what `trayambak` on `PATH` ran.** The globally installed `@skt-ai-labs/trayambak-cli@0.6.5` shadowed the `bin\*.cmd` shims, and its bundled `dist` still contained the dump handler: `trayambak --dump-system-prompt` printed **92 KB** of the live prompt (tool definitions, memory block, project rules) and exited **0**, so it looked like a successful no-op to any script. npm's latest is also 0.6.5, so no upgrade path existed — the leaky global copy was uninstalled and `PATH` now resolves to the patched `bin\trayambak.cmd` / `bin\skt.cmd`. Verified end-to-end after the change: both binaries print the 100-byte refusal and nothing else, with exit 2.
- **`bin\trayambak.cmd` and `bin\skt.cmd` swallowed the CLI's exit code.** `endlocal` resets `ERRORLEVEL`, so _every_ refusal and error surfaced as exit 0 through the shim — including this one, which is why the leak looked harmless. Both shims now capture `%ERRORLEVEL%` before `endlocal` and re-exit with it; confirmed the shim now reports 2 for the refusal and for an unknown command, and 0 for `--version`.
- Recorded so the same trap is visible next time: a patched source tree means nothing while a stale published copy shadows it, and a shim that flattens exit codes hides the difference between "refused" and "succeeded".

### Removed — `--dump-system-prompt`: the system prompt is never printed or persisted

- **`trayambak --dump-system-prompt` is gone** (handler, `GLOBAL_FLAGS` entry, and all three docs + README mentions). It wrote the agent's full prompt — every tool definition, the memory block, project rules, mode/specialist blocks — to stdout, where it lands in shell scrollback, CI logs, crash artifacts and screenshots. An old script now gets a loud refusal on stderr and **exit 2** instead of a silent empty chat (an unrecognised flag in the command position falls through to `case undefined:`, so without the refusal the flag exited 0 having printed nothing). Refusal lives in `refuseSystemPromptDump()` (`command-registry.ts`) so it is unit-testable without `main()`'s evalr side effects.
- **The prompt is no longer written to disk**: `Session.save()` persisted `{ system, messages }`, parking the full capability spec in plaintext in every `--session` file (and any backup/archive of it). It was also never read back — `Agent` rebuilds the prompt from config via `setSystemPrompt()` immediately after `Session.load()` and again before every run — so the stored copy had no consumer. `save()` now writes messages only; `load()` still accepts a legacy `system` field and **discards** it, so old session files resume unchanged while ceasing to be a leak.
- **Attempted dumps are recorded, not executed**: the refusal logs a `prompt_exfil_attempt` event (`apps/runtime/src/security-log.ts`, append-only JSONL, `TRAYAMBAK_SECURITY_LOG` to relocate) with the shim name and flag — the attempt is the evidence, the prompt is never in the log. Verified live: both `trayambak --dump-system-prompt` and `trayambak run --dump-system-prompt` exit 2 with the refusal on stderr and nothing on stdout, each attempt landing as one JSONL row.
- **Guards**: `apps/cli/src/system-prompt-lock.test.ts` pins that the refusal fires for the flag in _any_ argv position, writes nothing for ordinary argv, and uses the invoking shim name; the registry test asserts no registered flag name/description can dump the prompt (it would otherwise reappear in `--help` and shell completion); new `apps/runtime/src/session/session.test.ts` pins messages round-trip, prompt absent from disk, and the legacy-field discard; a new `check-forbidden-strings.yml` step fails on any _executable_ reference to the retired flag, a re-persisted `system:` in `session.ts`, any stdout/stderr write of the prompt, or removal of the refusal/guard tests. Locally simulated with four synthetic regressions (re-persisted prompt, stdout write, deleted refusal, deleted guard test) — all four detected.
- Verified there is no other surface: the server, ACP and MCP surfaces never expose it, and compaction receives it purely for token accounting (it is never written into a summary, the `compaction` event carries counts only, and analytics redacts that event's only free-text field).

### Added — weakness-audit round 2 (security hardening, test-depth sweep, real bugs fixed)

- **Audit log tamper-evidence**: `packages/core/src/state_db.ts` audit rows are now a SHA-256 hash chain (`prev_hash`/`hash`, `GENESIS_PREV_HASH` genesis, guarded `ALTER TABLE` migration, JSON-backend parity + JSON→sqlite import) with a new exported `verifyAuditChain(db)` flowing through the core index and 17 chain tests. `recordAudit`'s signature is unchanged; the tail-truncation limitation is documented honestly.
- **Redaction wired into every sink** (prose-safe `redactPayload()` in `packages/core/src/secrets.ts` — credential-gated only, cycle-safe, never truncates; tests prove >24-char paths/prose round-trip byte-for-byte, and `ghp_`/`gho_`/`github_pat_` patterns were added): hook handler boundary + hook-produced output (`hook_runtime.ts`), shell-hook stdin `tool_input` + child-env allowlist (`apps/runtime/src/tools/hook-exec.ts`), analytics `recordEvent`/hook facts/compaction metadata (`analytics.ts`), telemetry debug stderr (redact→JSON, 2000-char cap, stderr-only) — plus a new `packages/telemetry/src/index.test.ts` (8 tests, previously zero) covering the `TRAYAMBAK_TELEMETRY=0` kill-switch.
- **Sandbox + exec honesty (remainder)**: `enforcementForBackend()` is the single reporting source and every path reports `policy-only` while the flag is off (`packages/sandbox/src/gate.ts`); bash `buildBashEnv` is an allowlist applied after `filterEnv`; win32 `detectAvailableSandbox()` no longer claims `WindowsRestrictedToken` (returns `None` with the delegation note) + new `packages/sandbox/src/types.test.ts` (6 tests pinning `CODEX_SANDBOX` honesty across platforms); `docs/security.md` rewritten to describe flag-adjusted behavior instead of overstating it.
- **CI guard-the-guard**: the "approval switches must be exhaustive" step (satisfied by any `default:` within two lines of any `switch`) is replaced by assertions that the AST rule `trayambak/approval-mode-exhaustive` exists, is registered `error` _everywhere_ it appears in `eslint.config.mjs`, keeps its behavioral tests, and that `approvalFor()` remains the single decision point. Verified locally against the real tree plus synthetic downgrade/export-removal cases.
- **`no-cross-package-import` apps/cli boundary ratcheted, not disabled**: `ENFORCE_APPS_CLI_SCOPE = true` with exactly the 9 measured legacy import sites grandfathered per file+package (documented debt), so any _new_ apps/cli import outside `core`/`execpolicy` is an error. The map only shrinks — migrating a site deletes its row, it never grows.
- **Real bugs the new tests exposed**: ACP `stopReason: "cancelled"` was unreachable (the cancel flag was deleted before it was read) and a cancel flag could outlive a failed run, muting the next prompt on that session (now cleared in `finally`; `packages/acp` at 16 tests); `SubagentOrchestrator` stored `crossMonitorSubagents` detached from its receiver, so the monitor interval threw on every tick with prototype-method engines (invoker closure; the test now drives the raw engine, so reintroducing the detached store fails it); `ParentWatchdogService.start()` double-arm leaked an interval `stop()` could never reach; `TextStreamService` chunked with `/./`, which silently dropped every newline in multi-line output (`/[\s\S]/` + byte-for-byte round-trip tests).
- **Server CORS wildcard removed (security)**: `packages/server/src/index.ts` sent `Access-Control-Allow-Origin: *`, so any website a user visited could call the endpoints that sit _below_ the auth gate by design — `/license/activate`, `/license/mint-trial`, `/auth/github/*`, `/github/read` — from that page. New `packages/server/src/cors.ts` decides per request: no `Origin` (curl, node client, the CLI) passes; same-origin passes; loopback origins pass on any port (local dev servers); extra origins come from `TRAYAMBAK_WEB_ORIGINS` (exact match, `*` restores the wildcard); anything else is **refused with `403` before routing** — refusing server-side is the load-bearing part, since a "simple" cross-origin POST (`Content-Type: text/plain`) triggers no preflight and would still have reached an unauthenticated route with CORS headers merely stripped. Echoed origins get `Vary: Origin`; `OPTIONS` answers `403` instead of `204` for a refused origin. 19 new tests (15 policy + 4 end-to-end through a live server), plus `docs/web.md`, `docs/getting-started.md`, `README.md` and the CLI `Environment` help block.
- **Same-millisecond id collisions no longer overwrite data**: plans, notebooks and board posts derived ids straight from `Date.now()`, so two creates inside one millisecond collided — and `plans`/`notebooks` are `Map`-keyed by id, meaning the second `create()` silently replaced the first while the caller still held the dangling object; plan steps collided too, so `updateStep` patched whichever row the scan found first. New `apps/cli/src/integration/unique-id.ts` keeps the time prefix (ids stay sortable, readable, and every persisted id keeps working) and appends a numeric suffix only on an actual collision, checked against live _and_ on-disk ids so a fresh process cannot reissue one.
- **`plan.ts` resolves its store path per call** instead of capturing `os.homedir()` at import (which made the path depend on import-time environment). The two integration suites now hold the temp-HOME stub for the whole file instead of restoring it right after the dynamic import — that restore was only safe while the path was frozen at load, so writes would otherwise have landed in the developer's real `~/.trayambak`.
- **`isSecretKey` no longer masks token counters**: the substring rule meant `maxTokens`, `inputTokens`, `tokensBefore`, `tokenCount` (and `max_tokens`) were replaced by `"****"` — NaN-ing analytics aggregates and handing hooks `maxTokens: "****"` instead of a budget. A narrow `TOKEN_COUNTER` vocabulary (fixed modifier/suffix list, and only when the key carries no _other_ secret marker) is now exempt, while a bare `token`/`tokens`, `githubToken`, `apiToken`, `accessToken`, `refreshToken`, `idToken` and anything containing `secret`/`apiKey`/`authorization` still mask. All three redactors (`redactSecrets`, `redactLogValue`, `redactPayload`) now route through the single `isSecretKey` decision point instead of re-implementing the check.
- **License-header drift closed**: 6 files written after the relicense sweep still carried our Apache-2.0 header (`core/secrets.ts`, `core/approval.ts` + test, `execpolicy/policy.test.ts`, `agent/loop-approval-ladder.test.ts`, `tools/toolset-parity.test.ts`); `scripts/relicense-proprietary.mjs` reverted exactly those 6. The only remaining mentions are intentional data — the sweep's own `/Apache License/` match pattern and `rebrand-skt.mjs`'s Apache `NEW_HEADER` constant.
- **Test depth**: 41 new files / 388 tests in previously zero-coverage areas — `packages/acp`, `packages/cli` registry (100%), tools/commands, planner, knowledge-gate, evidence, mistakes, developer-mode (50 tests, dir 99.0% lines), `packages/tui/src/logic` (9 files, 44 tests, 99.6% lines), `apps/cli/src/integration` (14 files, 124 tests, 98.8% lines), the extracted `provider-model-support` helpers, the new `cors` policy and `unique-id` helper. Suite: **240 files / 2,705 passed** (4 skipped); coverage **66.00 / 77.35 / 73.23 / 66.00** repo (floors 55/73/63/55) and **86.96 / 87.45 / 87.14 / 86.96** core (floors 79/85/83/79); `verify-all-tools` 71/71 ok against the 83-tool catalog; `npm run lint` 0 errors; typecheck, build, e2e, `check:links` and `format:check` green.
- **`packages/tui/src/ink-app/App.tsx` back under the 4000-line cap by extraction, not by a cap raise**: the 4061-line shell now delegates its stateless provider/model helpers (picker row mapping, provider label/host, model-cache + `resolveModels`, per-backend key memory) to a new `provider-model-support.ts`. Every extracted function closed over module imports only, so the hoist is behavior-identical; its test module pins that. The new test also caught a display bug: `providerHostFor("localhost:8080")` returned an **empty host** (`new URL` parses scheme-less input as a protocol with no host), so the picker showed a blank provider for a host:port the user had typed — now it falls back to the raw input.

### Changed — relicense back to proprietary (owner-authorized)

- `LICENSE`: Apache License 2.0 → **Trayambak CLI Proprietary License** (limited, non-exclusive, non-transferable use licence; copying/modification/redistribution/reverse engineering require written permission; third-party components keep their own terms). This reverses the 0.6.0 relicense and restores the original distribution terms.
- `package.json` / `package-lock.json` (root entry) / `apps/vscode-extension/package.json` / `publish/package.json`: license → `SEE LICENSE IN LICENSE`; `package.json` description updated.
- 432 source headers reverted to the proprietary header via new `scripts/relicense-proprietary.mjs` (idempotent, leading-comment-only, skips third-party content). `scripts/rebrand-skt.mjs`'s `NEW_HEADER` constant fixed — it still held the Apache text and would have re-Apache-ized the tree if rerun.
- `README.md` License section, `AGENTS.md`, `docs/README.md` updated to proprietary terms (they had carried the Apache wording since the 0.6.0 relicense).
- Untouched on purpose: bundled skills' `license:` frontmatter (third-party Apache-2.0/MIT content — see `skills/energy-procurement/SKILL.md:12`), `package-lock.json` dependency license fields (factually correct for those packages), `CHANGELOG.md` 0.6.0 entry (immutable release history).

### Fixed — web server auth fail-closed on non-loopback binds

- `packages/server/src/index.ts`: binding to a non-loopback address without a configured token used to serve unauthenticated control of the runtime. It now auto-generates a random 64-hex token, exposes it as `effectiveToken` on `TrayambakServer`, and prints it once at listen time — fail-closed by default, not opt-in. Loopback-only binds without a token keep their documented local-dev behavior, and an explicitly configured token still wins. +2 tests in `packages/server/src/index.test.ts` (6 total). Docs aligned: `docs/web.md`, `docs/security.md`.

### Removed — `better-sqlite3` residue (audit / clean-install gap)

- Root `package.json`: dropped from `dependencies`, `devDependencies` and `allowScripts`; `package-lock.json` re-synced (`npm install --package-lock-only --ignore-scripts`) → zero `better-sqlite3` entries remain and `npm audit --omit=dev` reports 0 vulnerabilities (6 remaining findings are pre-existing dev-only vitest/vite/esbuild advisories). The runtime never required it — `packages/core/src/state_db.ts` is a JSON-backed store by design.
- `publish/package.json` was a stale generated artifact still shipping `better-sqlite3@^11` to npm consumers — entry removed (the generator `scripts/make-publish.mjs` copies root deps, so regeneration stays clean).
- Orphan helper scripts that only serviced the native module deleted: `rebuild_sqlite.bat`, `check_deps.bat`.

### Added — agent-loop guard + controller state-machine coverage (test gap)

- `apps/runtime/src/agent/agent-loop-guards.test.ts` (+26 harness tests): previously untested fail-closed paths of `runAgentLoop` — 429/backoff incl. `retryAfter`, mid-retry abort, bounded transient restarts (no eternal spinner), doom-loop approval gate, per-prompt and distinct-tool limits, permission deny / ask-blocked / ask-approved gates, hook-ask gate, unknown tool / thrown error / tool timeout, streaming placeholders, text-fence tool-call extraction, developer-mode verification (pass and fail), context-overflow → force compaction, and pre-aborted signals. `agent-loop.ts` coverage **45.5% → 93.7%** statements (78.6% branches).
- `apps/runtime/src/controller/controller.test.ts` (+36 unit tests): `state.ts`/`router.ts`/`roles.ts`/`reviewer.ts`/`controller.ts`/`executor.ts` were 0% — now 100/100/100/100/100/96.55 — covering every `route()` transition (incl. repetition/strategy escalation), search-budget accounting, and the executor's permission-deny / unknown-tool / throw / `isError` paths with in-memory tool doubles.
- Suite totals after these additions: 139 files / 1,674 passed (4 skipped); coverage 50.89 lines / 75.24 branches vs gates 47/73; `npm run lint` 0 errors; `npm run typecheck` clean.

### Added — subagent engine + budget enforcement + checkpoint/rewind (power round)

- **Subagent spawning is real and guarded**: `apps/runtime/src/agent/agent.ts` injects a depth-guarded runner through the `trayambak__Agent` tool — each spawn gets a fresh `Session`, reuses the parent provider (or the `model` override), strips fan-out tools (`trayambak__Agent`/`RunTeam`/`ParallelReview`/`ParallelExecute`) and routes through `SubagentEngine` (`packages/core/src/subagents.ts`): `maxDepth` 3 with a structured `depth_limit_exceeded` refusal _before_ any child loop, per-task usage summaries (`turns`/`toolCalls`/`durationMs`/tokens), background registry (start/status/await/cancel via `AbortController`), emitting the existing `subagent_start/end` + `subagent_background_start/end` protocol events. Harness: `subagent-spawn.test.ts` proves a child loop really runs (tool result lands in the child session only), the parent gains summary-only, and a depth-3 agent is refused before any level-4 provider call.
- **Budget enforcement in the loop** (previously silently bypassed — nothing consulted `shouldBlockForBudget()`): `runAgentLoop` applies `config.budget` on entry, checks `shouldContinueTurn()` at the top of every turn, and stops with a new `budget_exhausted` protocol event (`{used, max, remaining}`, one additive union member — all consumers grepped first) followed by `agent_end`. Never silently continues; integration test proves `providerCalls` stays bounded (2 calls instead of 50).
- **Budget surface**: `budget` config field, `TRAYAMBAK_BUDGET` env (rides the existing config env allowlist — no new lint warnings), and a global `--budget <spec>` flag (`50k`, `1.5M`, `50000 tokens`, `40 turns`; `-1` disables). Invalid specs warn + fall back per config rules. `packages/core/src/token_budget.ts` rewritten (`parseTokenBudget`, `toRolloutBudgetConfig`, `applyBudget`, `budgetStatus`, `shouldContinueTurn`) — `rollout_budget.ts` touched only through its public API. Token usage per response uses the documented `ceil(chars/4)` estimator (protocol carries no real usage fields — labeled estimated everywhere); dollars are rejected on purpose (no pricing tables — would invent precision).
- **Checkpoint/rewind tools**: `trayambak__Checkpoint` (sha256 manifest, 10MB/file + 100MB total caps, atomic tmp+rename with manifest written last, cwd-only + symlink-escape guards, refuses `.trayambak/checkpoints/**` self-recursion) and `trayambak__Rewind` (verifies hashes _before any write_, stashes current bytes under `<id>/replaced/`, subset restore, id/label lookup, no path ever joined from raw input). Both registered in the `core` toolset so `Arsenal.resolveTools` actually delivers them to the model. 20 tests (1 privilege-gated skip on non-elevated Windows).
- Docs/help: root help Environment block lists `TRAYAMBAK_BUDGET`; `docs/getting-started.md` documents `--budget`.
- Tests: +66 across the three features (24 budget, 22 subagent, 20 checkpoint) — suite at 123 files / 1,465 passed; coverage totals now 48.44/74.19/59.91/48.44 vs thresholds 42/72/51/42.

### Fixed — production-readiness hardening

- `apps/cli/src/session/session-manager.ts`: UUID ids (no `Date.now()` collisions), disk persistence (`~/.trayambak/sessions.json`, atomic 0600 writes), `fork()` honors requested name, `update()` preserves `id`/`createdAt`.
- `apps/runtime/src/config.ts` + `packages/session-backends/src/index.ts`: atomic writes with `0600` perms for `config.json` and transcripts.
- `package.json`: strict `build`/`build:ink` (fail on type errors, `build:loose` keeps old behavior), new `test`/`lint`/`format`/`sbom` scripts, `publish:npm --provenance`, `publish:build:debug` skip-obfuscation flag.
- CI: new `.github/workflows/ci.yml` (typecheck, eslint, prettier, vitest matrix 18/20/22, build smoke, npm audit + SBOM).
- `SECURITY.md`: supported versions, 3-day ack / 14-day fix SLA, scope, secret-handling, provenance/SBOM notes.
- `Dockerfile` + `.dockerignore`: Linux prod image; `eslint.config.mjs` + `.prettierrc.json` added.
- `scripts/make-publish.mjs`: `TRAYAMBAK_SKIP_OBFUSCATION=1` for debuggable builds.

### Added

- `packages/protocol`: shared message, tool, and event types.
- `packages/provider`: llama.cpp OpenAI-compatible streaming client with native and text-fallback tool calling.
- `packages/core`: agent loop, tools (bash, read/write/edit file, list_dir, grep, glob), session, prompts.
- `packages/tui`: terminal rendering and input.
- `packages/cli`: `run`, `serve`, `config`, `models` commands.
- `packages/server` / `packages/client`: local HTTP surface and client SDK.
- `packages/coding-agent`: high-level task orchestrator.
- `packages/session-backends`, `packages/telemetry`, `packages/schema`, `packages/function`, `packages/evals`: supporting modules.

## [0.6.0]

### Fixed — test-suite order/load dependence (the audit's last open item)

- `webbrowse.test.ts`: module-singleton browser session leaked across tests; added `resetWebBrowseSession()` and made every journey test seed its own state → passes under `--sequence.shuffle.tests`.
- `hook-exec.test.ts`: programmatic hooks registered on the process-wide HookRuntime leaked into later tests (flipped config-hook denials to "Denied by a registered PreToolUse hook"); clear-before-each + order-safe `clear()` default test.
- `healing.test.ts`: prevention-rule retrieval self-seeds and asserts membership, not journal position.
- `rules.test.ts`: guard now skips when ANY ambient ancestor rule exists (a stray `AGENTS.md` above the temp dir broke it — environmental, not order).
- `license.test.ts`: 13-bit mint rand made a 10-key batch flaky (~0.5% birthday collision); bounded-retry uniqueness assertion.
- `evals`: `reportEvals` fixture no longer prints `FAIL b (missing)` into suite/CI logs (stdout captured, content asserted instead).

### Added — repo governance

- `.github/CODEOWNERS` (protected areas + default review owner; placeholder handle to swap on push) and `.github/PULL_REQUEST_TEMPLATE.md` (AGENTS.md review checklist as PR gates).
- Everything uncommitted since the last security commit landed as one tracked snapshot (reviewer complaint: "nothing is committed").

### Fixed — weakness sweep (audit follow-up)

- Stale versions: `docs/{getting-started,acp,troubleshooting,web}`, `packages/execpolicy/package.json`, MCP serverInfo `0.5.0`→`0.6.0`.
- Verified closed by tree: approvalFor wired in loop, recordAudit via auditSink, redaction in loop/hooks/analytics/telemetry/journal/config, gitleaks SHA-pinned, SECURITY at 0.6.x.

### Fixed — devmode correctness (found while chasing suite red)

- `needsClarification` always returned false (`if (hasDetails)` on a regex object — truthy forever); now `.test(lower)`.
- Penalty temperature used raw IEEE sums (`0.1+0.1≠0.2`); accumulator rounds to 3 decimals like the setter; escalation test aligned to cumulative semantics.
- Serialized `cotChain` strings no longer wipe sibling defaults on merge.

### Fixed — audit round 2 (bugs the deep audit confirmed)

- Env filter hardened: 9 → 19 deny patterns (DATABASE_URL, DSN, WEBHOOK, NPM/Bearer/JWT/Cookie/Session/Auth, Docker, Kube) + tests; shells keep working env.
- `logout()` clears without deleting (no path oracle); `loginStatus` reads key presence, not file existence + tests.
- ExecPolicy `.rules` files load from `./.trayambak/exec.rules` + `~/.trayambak/exec.rules` on first use (DSL was dead); network matching is separator-aware (`domainMatches` + tests).
- Server token compare is constant-time (`timingSafeEqual`); Docker runs as `node`, not root.
- `TRAYAMBAK_TELEMETRY=0/false/off/no` force-disables telemetry + test.
- Fixed WIP breakage found along the way: duplicate `getDatabase` import, `github.ts` base64 `undefined`, dev-mode test `required: []`.

### Fixed — approvalFor() ladder is now the real gate (user-reported audit)

- `runOneTool` routes every tool call through `approvalFor()` (deny hard-blocks + records on the run's `DenialTracker`, ask emits `permission_request`, allow proceeds); new `RunConfig.approvalTracker` persists counts across turns. Harness extended (`TestLoopOptions.approvalTracker`) + new `loop-approval-ladder.test.ts` (deny/ask/full-access/approved paths, provider-call assertions).
- Drive-by: fixed `github.ts` base64 `string|undefined` type error in new code.

### Fixed — external security audit (7 findings, all verified true)

- Keys: `data/` gitignored (17 live `1102-*` keys were one `git add .` from public); never committed, verified clean; custom `skt-license-key` gitleaks rule added (placeholder allowlisted).
- Redaction wired: `config get/set` masks secret values, `logMistake` free-text goes through new `redactEmbeddedSecrets` (prose-safe; logger already used `redactLogValue`); `isSecretKey` exported + tests.
- CI repaired: `session-analytics.yml` `--filter` (invalid vitest flag) → `-t` file+pattern run, verified 14 pass.
- Security chain committed: `secret-scan.yml`, `dependabot.yml`, `.gitleaks.toml` were untracked — now committed.
- Execpolicy tested (was 0 tests): parser/multi-word patterns, deny-wins, amendments, network rules; fixed real parser bug (multi-word patterns truncated to first token) + watcher EPERM crash.
- Lint honesty: implemented `approvalFor()` (the mandated single decision point + `DenialTracker`); `no-sandbox-env-touch` retargeted from ghost `core/sandbox.ts` to real `packages/sandbox/`.
- Docs: ACP agentInfo `0.5.0`→`0.6.0` in code; 5 stale `0.5.0` doc refs updated (SECURITY already at 0.6.x).

### Fixed — pentest output cap (user-reported deep audit)

- `runShellCommand` accumulated scanner stdout/stderr unbounded — one verbose scan could balloon process memory before `truncateOutput` ever saw it. Both streams now cap at 256KB with a `[truncated]` marker (`appendCappedOutput`, unit-tested).

### Fixed — orphaned AgentCatalog tool (user-reported)

- `trayambak__AgentCatalog` was registered but belonged to no toolset, so `Arsenal.resolveTools` stripped it whenever config existed while the system prompt advertised it → "Unknown tool". Added to the `agentic` toolset; new `toolset-parity.test.ts` asserts both directions (every registered tool in ≥1 toolset, every toolset entry registered) including the exact reported scenario. Guard proven to fail without the fix.

### Fixed — provider picker overflow (user-reported)

- Rows render as one truncating text node on exact columns (fixed number column, flexible label + endpoint with `…` cuts via `fitProviderRow` + test) — long endpoint URLs no longer wrap into neighbours or push rows out of the frame.

### Fixed — MCP spawn chain (user-reported, round 2)

- Root cause found by reproduction: registry specs spawn bare `npx`, and both stdio spawn sites (`McpConnection`, `McpRunnerTool`) passed it raw → `spawn npx ENOENT` from GUI shells. New `packages/mcp/src/spawn-resolve.ts` (single copy; installer deduplicated onto it): `npx` → `node npx-cli.js`, `node` → running binary, `python*`/`uvx` → resolved absolute path with human-readable "not installed" errors, unknown commands pass through for existing diagnostics. Wired into both spawn sites + tests.

### Fixed — MCP install + permission modes (user-reported)

- `mcp__install` no longer spawns bare `npm`/`pip` (ENOENT from GUI-launched shells): new `resolveExecutable()` probes PATH (`where.exe`/`command -v`), the node install dir, and well-known locations, preferring spawnable PATHEXT executables (`.exe` > `.cmd` — never the extensionless POSIX shim), with a human-readable "not found" message instead of `spawn npm ENOENT`.
- `full-access` mode: nothing blocks — `evaluatePermission` returns allow before any rule layer.
- `auto-approve` mode: only delete-family operations (`rm -rf`, `del /s /q`, `Remove-Item -Recurse -Force`, `format`, `mkfs` via `DELETE_FORCE_ASK_RULES`) can still ask; stock default denies are skipped, your own session/config denies still gate. Docs (`security.md`) + `/mode rules` notice updated; spec tests rewritten.

### Added — core systems (AGENTS.md module map)

- `packages/core/src/feature_flags.ts` (+test): `STABLE_FEATURES` + `FEATURE_<NAME>` env overrides; surfaced as `trayambak flags`.
- `packages/core/src/permissions.ts` (+test): `Tool(glob)` rule engine, deny-first evaluation, `DenialTracker`.
- `packages/core/src/plan_mode.ts` (+test): read-only tool gate, 0600 plan files under `.trayambak/plans/`, approved-command checks.
- `packages/core/src/subagents.ts` (+test): isolated Task workers with `MAX_SUBAGENT_DEPTH` guard + usage summaries (injected runner: deterministic, network-free).
- `packages/core/src/token_budget.ts` (+test): `128k`/`1.5M` budget parsing, `TurnBudget` consumption/exhaustion/bounded continuation.
- `docs/architecture.md` module table updated.

### Changed — Apache-2.0 relicense (owner-authorized) + WIP stabilization

- `LICENSE`: Proprietary v1.0 → Apache License 2.0 (© 2026 SKT AI LABS PRIVATE LIMITED); `package.json` license `Apache-2.0`; 400 source headers + `AGENTS.md`/`docs/README.md`/vscode-extension manifest updated.
- Fixed concurrent-author WIP so the tree is green again: sandbox `spawn.ts` (seatbelt names, pid guards, signal casts), `core/process.ts` (no require, typed signals/streams), `core/env_filter.ts` (ProcessEnv input), `core/state_db.ts` (JSON-file backend — no native `better-sqlite3` dep; same API), `core/hook_runtime.ts` (`additionalContext`), `core/agent_registry.ts` (`uuid()`), `command-exec/bash.ts` (no `ctx.emit`, unknown-cast permissions), `prompt/auto-title.test.ts` (unknown-shape helper), `tools/text/*.test.ts` (protocol import), `tui/ui/footer*.ts` (Theme import, indicator fn), sandbox `index.ts` (dedup re-exports).

### Fixed — TUI glyph corruption (broken `?` symbols)

- New `packages/tui/src/ink-app/glyphs.ts`: single glyph table (`g()`) + `TRAYAMBAK_GLYPHS=ascii|unicode` override (Unicode default with `❯` user markers; ASCII strictly opt-in). Restored all recoded literals (`?`/U+FFFD → ●○◌✓✗★❯█⚠) across 19 components; `vitest.setup.ts` pins Unicode so the suite is OS-deterministic.
- Resume picker: rows render as one truncating text node on exact fixed-width columns (status/date padded, name budgeted with …); wrapped tails no longer collide. Picker opens with list-time backfill (`backfillUntitledSessions` + test) so default-named sessions show their real title immediately; resume-select backfill kept as well.

## [0.5.0]

### Changed — production hardening (7-axis scorecard push to 10)

- **Dead code removal**: deleted orphaned `apps/cli/src/agent/` (58 files — enforcement actually lives in agent-loop, protocol engine and runtime bash), plus fake/dead commands (`stats`, `daemon`, `profile`, `roll-call`, `cloud`, `session-import`, `console`, `integration/cloud`, `integration/config-validation`). Wired previously dead `resume` and `export` as real subcommands; `export` honors `--format json|text|markdown`.
- **Release correctness**: version single-sourced from `package.json` via `scripts/sync-version.mjs` (stamps `apps/cli/src/version.ts`; CI fails on drift). Every build runs `clean-dist.mjs` so stale dist is structurally impossible; `bin/*.cmd` shims self-heal via `check-dist.mjs`. New `verify:pack` gate asserts tarball contents (entry+shebang, no tests/maps/journals, ≥50 personas, secret scan).
- **Command registry**: new `command-registry.ts` as single source for root help, `<cmd> --help` / `help <cmd>`, strict flag validation (aliases canonicalized, unknown flags exit 2) and shell completion (bash/zsh/fish/powershell); exit codes standardized (0 ok / 1 error / 2 usage).
- **Observability**: structured JSON logger with file sink + rotation (`TRAYAMBAK_LOG`, `TRAYAMBAK_LOG_LEVEL`, `TRAYAMBAK_LOG_DIR`); unknown commands and fatals are logged, not swallowed.
- **Sandbox honesty**: `detectBackend()` now probes for real integrations (`/usr/bin/sandbox-exec`, `/usr/bin/bwrap`) and returns `fallback` otherwise — it no longer claims unwired OS backends (landlock/restricted-token are documented as reserved). Every check reports `enforcement: "policy-only"`; `sandbox`/`execpolicy` CLI output states that no OS sandbox is spawned. `DEFAULT_EXEC_RULES` strengthened (mkfs/dd/reg delete/vssadmin/pipe-to-shell, ordered first-match).
- **Config**: `--config <file>` / `TRAYAMBAK_CONFIG` now actually honored by `configPath()` (was declared in `--help` but unused); applied uniformly to every flag-parsing command.
- **Mistake journal**: `skt/1-errors/mistakes.json` moved to user state dir (`~/.trayambak/skt/1-errors`, `TRAYAMBAK_STATE_DIR` override) with one-time legacy migration — never shipped in the tarball.
- **CI/CD**: `ceo-audit.yml` deleted (depended on unavailable external repos/secrets, could never pass); `ci.yml` gained blocking `npm audit --omit=dev --audit-level=high`, SBOM artifact, coverage-threshold job, version-sync gate, Windows test/build legs with `bin\*.cmd` shim smoke tests, and a `verify:pack` job; `release.yml` gained tag↔version gates, blocking SBOM, pre-publish tarball verification and auto GitHub Release notes.
- **Repo hygiene**: 2,029 files / 12.9 MB removed (stale `.bak`, compiled artifacts, legacy reference TUI); `.gitignore` covers coverage/, journals, bin binaries, backups; `bin/README.md` documents llama.cpp binary provenance.
- **Lint + format**: repo-wide Prettier pass (579 files) and all ESLint errors fixed (was 16: dead files `file-icon.ts`/`update_prompt*.js` deleted, `require()` → ESM imports, dead render-cache vars removed, `@ts-ignore` dropped once proven unnecessary); `npm run lint` exits 0 and `format:check` passes.
- **Help rendering**: long usage lines no longer glue onto their summary (`trayambak config …[value]Manage configuration values` bug), with a regression test over every visible command row.
- **Docs integrity**: new `npm run check:links` gate (`scripts/check-docs-links.mjs`) validates every internal doc link and `#anchor` slug; wired into CI's schema job.
- **Release path proven**: obfuscated `publish:build` + `verify:pack` verified end-to-end (332 files obfuscated; pack gate's version check correctly falls back to `publish/package.json` when the literal is string-array-inlined); obfuscated artifact smoke-tested (`--version`, `help <cmd>`, unknown-command exit 2).

### Added — CLI-only round 2 (no provider changes)

- `packages/modes/src/index.ts` + `modes` cmd: 5 built-ins + `.roomodes` loader; `docs/modes.md`.
- `packages/approval/src/index.ts`: prefix allow/deny + protected files; `packages/core/src/validate.ts` required-args guard; `docs/approval.md`.
- `packages/mcp-server/src/index.ts`: real `read_file`/`bash` exec (bounded); project `.trayambak/mcp.json` scope merged in `config.ts`.
- `packages/checkpoints/src/index.ts` + `checkpoint` cmd: file-snapshot create/list.
- `packages/core/src/i18n.ts` (en/hi) + `PRIVACY.md`; `scripts/e2e.mjs` + `test:e2e` + CI e2e gate.
- Providers unchanged (10 BYOK) per request.
- `apps/cli/src/commands/exec.ts`: headless `exec` JSON events + `review`; `archive.ts`: `archive/unarchive/delete`.
- `packages/server/src/daemon.ts`: pid lifecycle; `config.schema.json`; `docs/README.md` full guides.
- `ci.yml`: +schema/docs +codespell jobs; version `0.5.0`.

## [0.4.0]

### Added — parity push to 10

- `packages/session-backends/src/transcript.ts`: per-session `sessions/<uuid>/{context.jsonl,wire.jsonl,state.json}`, empty-skip, legacy migrate, newest-first list.
- `packages/acp/src/index.ts`: ACP stdio JSON-RPC (`initialize/new_session/load_session/list_sessions/set_model/prompt/cancel`); CLI `trayambak acp`.
- `packages/server/src/index.ts`: `/api/sessions`, `/openapi.json`, CORS, `Bearer` token (`TRAYAMBAK_WEB_TOKEN`); CLI `trayambak web --port 8787`.
- `apps/cli/src/index.ts` + `flags.ts`: wired dead `serve`/`download`, new `acp`/`web`, `--key=value` + `--no-*` parsing, `--config/--port/--host` flags.
- `packages/core/src/secrets.ts`: `withFileLock` + `redactSecrets` + `secureDir` (0700).
- `.github/workflows/release.yml`: multi-OS build + SBOM + npm `--provenance` publish; `docs/README.md`; version `0.4.0`.
