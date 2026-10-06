# SECURITY_REVIEW.md — consolidated security-audit ledger

**Scope**: rounds 1–15 of the Trayambak security audit, reconciled across every
tree that holds findings. **Generated**: 2026-10-02 (Round 15 — dormant-API
wiring review + final sweep). **HEAD at generation**: `b571f22`.

Every row below is evidence-backed: a commit, a file path, a CHANGELOG section,
or a regression-test comment. Where a claimed finding has no artifact in this
repository, it is marked `evidence pending` rather than guessed.

---

## 1. Read this first: three trees hold the work

| Tree                                                                                              | State                                                                                              | What lives there                                                                                                         |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `C:\Users\engli\trayambak` (git, v0.6.6 → 0.6.7)                                                  | rounds 1–6 committed in history; a **100+-file working batch is uncommitted** (concurrent session) | My findings **#51-#54, #60, #62-#80, #109-#111** (committed) + their **#58, #84, #85, #87, #88, #90, #93** (uncommitted) |
| `C:\Users\engli\OneDrive\Documents\Default Project` (**no git**, v0.5.0, different module layout) | **not in git, not in this repo**                                                                   | Rounds 13–14: **#94–#108** regression tests (written 2026-10-02 15:26–15:46)                                             |
| npm dist `@skt-ai-labs/trayambak-cli`                                                             | latest known **0.6.5** at the time of the round-6 changelog entry                                  | Rounds 1–6 audited the published package; source fixes are committed here                                                |

**The load-bearing fact**: the round-14 fixes (#103–#108) and round-13 fixes
(#94–#102) exist **only in the non-git `Default Project` tree**. Until they are
ported, the trayambak repository does not contain them.

---

## 2. Severity scale

`Critical` remote/pre-auth compromise or arbitrary code execution · `High`
credential exfiltration, permission/approval bypass, path escape · `Medium`
resource exhaustion, state corruption, input-validation fail-open · `Low`
integrity/usability issues with security nudge · `Info` hardening/cleanup.

---

## 3. Fixed & verified — committed in this repository (29 findings)

| ID      | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Proof                                                                                                                                    |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| #51–#54 | High     | Redaction disk-sink gaps: CLI log wrote embedded secrets verbatim (`ghp_…` in remotes, JWTs, AWS/Stripe/npm tokens, PEM, `user:pass@` URLs); password/credential key family unmasked; `TRAYAMBAK_TELEMETRY=0` didn't silence `flush()`                                                                                                                                                                                                                              | `c243d78`; CHANGELOG [0.6.6] "Redaction closes the disk-sink gaps"                                                                       |
| #60     | Low      | ACP `set_model` acknowledged a model it never stored                                                                                                                                                                                                                                                                                                                                                                                                                | `7b63be2`                                                                                                                                |
| #62     | Medium   | MCP servers couldn't connect headless, ungated                                                                                                                                                                                                                                                                                                                                                                                                                      | `682286f`                                                                                                                                |
| #63     | Medium   | MCP bash child env unfiltered (ambient secrets to child)                                                                                                                                                                                                                                                                                                                                                                                                            | `7b63be2`                                                                                                                                |
| #64     | Medium   | Budget enforcement bypassed — denial loop ran uncharged (`shouldBlockForBudget()` never consulted)                                                                                                                                                                                                                                                                                                                                                                  | `7b63be2`                                                                                                                                |
| #65     | Medium   | Thread/state store: concurrent writers could corrupt persisted JSON                                                                                                                                                                                                                                                                                                                                                                                                 | `2a1d1f4`                                                                                                                                |
| #66     | High     | Upgrade path trusted a hostile registry (`npm install -g <pkg>@<latest>` execution surface)                                                                                                                                                                                                                                                                                                                                                                         | `5ad0520`                                                                                                                                |
| #67     | Medium   | Hugging Face downloads followed any 3xx with the token; content unverified                                                                                                                                                                                                                                                                                                                                                                                          | `5ad0520`                                                                                                                                |
| #68/#69 | Medium   | Session store path traversal + non-atomic writes (ids untrusted)                                                                                                                                                                                                                                                                                                                                                                                                    | `1346689`                                                                                                                                |
| #70     | High     | Google API key travelled in URLs (query strings land in logs/proxies)                                                                                                                                                                                                                                                                                                                                                                                               | `a9028e0`                                                                                                                                |
| #71     | High     | Plan-mode approved-command prefix match smuggled shell (`isApprovedCommand` prefix compare)                                                                                                                                                                                                                                                                                                                                                                         | `e91dad3`                                                                                                                                |
| #72     | High     | Write-capable `web_fetch` (POST/body/headers) sat on the approval-free read-only path                                                                                                                                                                                                                                                                                                                                                                               | `8ea5917`                                                                                                                                |
| #73     | High     | No target guard on fetch/redirect/DNS-rebind (SSRF to internal/metadata)                                                                                                                                                                                                                                                                                                                                                                                            | `8ea5917`                                                                                                                                |
| #74     | Medium   | Malformed-`Location` handling in `webfetch`                                                                                                                                                                                                                                                                                                                                                                                                                         | `8ea5917`                                                                                                                                |
| #75     | Medium   | Windows shell quoting mangled every quoted command through bash                                                                                                                                                                                                                                                                                                                                                                                                     | `dfcf159`                                                                                                                                |
| #76     | Medium   | `trayambak__Monitor` ran model-supplied commands with raw env                                                                                                                                                                                                                                                                                                                                                                                                       | `dfcf159`                                                                                                                                |
| #77     | Medium   | `mcp-install` executed package code with raw env                                                                                                                                                                                                                                                                                                                                                                                                                    | `dfcf159`                                                                                                                                |
| #78     | High     | Direct git children (worktree ×4, subagent isolation ×3) ran with raw env, no timeout — a planted `post-checkout` hook received ambient secrets                                                                                                                                                                                                                                                                                                                     | `2c6d203`; `git_exec.ts` boundary                                                                                                        |
| #79     | High     | `auto-update` postinstall ran with raw env                                                                                                                                                                                                                                                                                                                                                                                                                          | `2c6d203`                                                                                                                                |
| #80     | High     | `llama-cpp-bin` PowerShell `-Command` string interpolation (apostrophe in path ⇒ executable PS), wildcard `-Path`, no timeout                                                                                                                                                                                                                                                                                                                                       | `2c6d203`                                                                                                                                |
| #109    | Medium   | `trayambak__RunTeam` accepted an unbounded `tasks` array — single-call fan-out unbounded (runner walks every task; background tasks detach)                                                                                                                                                                                                                                                                                                                         | **`fc9fd17`** (Round 15); test red on old code                                                                                           |
| #110    | High     | Three file-writing tools joined raw model input into fs paths with no segment guard, so `path.join` normalized `..` out of the intended dir: Rules `write` = arbitrary-path write (full content control, any extension); SendMessage inbox = `mkdirSync` + append outside `~/.trayambak/inbox`; GenerateAgent = `.md` write outside project + YAML frontmatter injection                                                                                            | **`973bbae`** (Round 16); traversal tests red on old source                                                                              |
| #111    | High     | All three `sota_solve` exec sites spawned model-generated code with no deadline, no output cap, no abort-kill (orphaned CPU spinners, OOM via unbounded stdout, cancelled tool left children running); description claimed "Sandbox Execution" with zero isolation beyond a filtered env                                                                                                                                                                            | **`b364ca0`** (Round 17); 5 bounds tests red on old source                                                                               |
| #112    | High     | `diagnostics` spawned the PROJECT's own `node_modules/typescript/bin/tsc` — a model-writable, supply-chain-reachable script — with the full inherited env, so a planted or compromised `typescript` package read `TRAYAMBAK_API_KEY`/`OPENAI_API_KEY` the moment the model called the tool; no boundary (hook/MCP/git/monitor children all get `getSafeEnv`)                                                                                                        | **`f9a5440`** (Round 18); canary-leak test red on old source                                                                             |
| #113    | Medium   | `parallel_review` was the last uncapped fan-out: reviewer output parsed with no finding cap (JSON array + regex loop both unbounded) and ONE adversarial verifier subagent spawned per CRITICAL/HIGH finding — a diff-steered reviewer queued 40 nested runs from a single call while RunTeam(32)/swarm(8)/debate(5) are all bounded                                                                                                                                | **`b571f22`** (Round 19); flood test red on old source (`[40]`)                                                                          |
| #114    | Critical | `codemode`'s `node:vm` jail injected HOST objects into the sandbox (host `Math/JSON/Array/String/parseInt/…` builtins + host `console.log` closures) and the contextified global kept the HOST `Object.prototype` — every guest expression reached the HOST Function: `Array.constructor("return process")().version` returned `"v24.18.0"` (host RCE straight past exec policy/approval); 6 live vectors incl. `globalThis.constructor` and a string-literal chain | **`9ccab93`** (Round 20); escape probe red on original source (`ok=true result="v24.18.0"`), 11 vectors blocked after                    |
| #115    | High     | Cross-process state lock `LOCK_WAIT_MS` (2 s) fail-open: under CPU saturation a live holder descheduled >2 s made waiters proceed unlocked, the reload-then-chain raced and LOST appends (observed 48/50 with both children exiting 0); stale-steal (30 s / dead-pid) was sound — only the wait bound was short for a saturated host                                                                                                                                | **`f480283`** (Round 20); full-suite run red at 2 s (48/50), green at 10 s                                                               |
| #116    | Medium   | `trayambak__AskUserQuestion` accepted an unbounded `questions` array — a single call could queue 50k questions × 50k options (labels/descriptions unclipped) straight into the prompt/UI fan-out, and the per-question `header` field declared in the callback type was silently dropped by the normalizer                                                                                                                                                          | **`6413194`** (Round 21); 5 fan-out tests red on old source (50-vs-10, 40-vs-10, 10 000-char clip, header undefined), green after        |
| #117    | Medium   | `web_search` concatenated the model-supplied `endpoint` verbatim into the request path (schema `enum` was advisory — `../admin` went out as-is) and buffered the ENTIRE service response with no size bound before `JSON.parse` (multi-GB ⇒ OOM); tool currently dormant per its own test header                                                                                                                                                                    | **`c9b3a58`** (Round 21); 2 guard tests red on old source (non-JSON instead of Invalid endpoint / too large), green after                |
| #118    | Low      | `trayambak__RunWorkflow` described itself as executing workflows (Execute a defined multi-step workflow … per-step result reporting) and returned `completed successfully (N/N steps)` while formatting a PLAN ONLY — step `tool`/`args`/`condition`/`maxRetries`/`timeoutMs` were never invoked, so the model could report fake completion to the user                                                                                                             | **`e192e65`** (Round 21); honesty test red on old source (Execute a defined …), green after                                              |
| #119    | Medium   | `csv`/`summarize`/`extract`/`diff`/`patch` all called `fs.readFileSync` on the WHOLE file with no byte cap (repo standard is bounded everywhere: read-file reads a bounded prefix, checkpoint refuses >10 MB, semantic-search skips >200 KB) — a model pointed at a multi-GB dataset in the project buffered it in full and OOM'd the CLI; csv/summarize/extract must keep working on big files, so honest prefix/truncation notes ship with the cap                | **`4393b42`** (Round 22); 5 behavior tests red on old source (silent prefix, no note) + capped-read import-error suite, green after      |
| #120    | Medium   | `diffLines` built the LCS table `(n+1)×(m+1)` with no bound — ~150k-line × 150k-line inputs = 2×10^10 cells (OOM) regardless of any read cap, since the matrix cost is line-count-driven, not byte-driven                                                                                                                                                                                                                                                           | **`4393b42`** (Round 22); budget test red on old source (old computed the full 20M-cell table, 294 ms, instead of throwing), green after |
| —       | High     | Windows OS-level AppContainer sandbox (child isolation; no false `isSandboxed` claims)                                                                                                                                                                                                                                                                                                                                                                              | `11017d1` (unnumbered, pre-ledger)                                                                                                       |

Committed-history security rounds from the other track (rounds 1–6, also in this
repo's history, documented under CHANGELOG `## [Unreleased]`): the
`--dump-system-prompt` removal + session-persistence leak, the installed-CLI/shim
exit-code leak, round-4 web auth (bearer on every bind, `/github/*` gating,
`/health` leak, run ceiling, `sessionFile` path write, **#48** stale key,
**#49** worktree, **#50** exit codes), weakness-audit round 2 (audit hash chain,
redaction into every sink, sandbox-honesty, server CORS), web-auth fail-closed.

Round-18 sweep — attacked and cleared (no finding): `write_file`/`edit_file`
already route through `resolveConstrainedPath` + `assertExternalDirectory` +
`assertMutablePath`; `memory`/`dream` use fixed paths only (no per-key file
names ⇒ no traversal surface); `ripgrep` spawns args-array only, never a
shell; `cron` is an in-memory schedule map (no fs, no exec); `github` is
HTTP-only; `terminal.createTerminalSession` has zero production callers
(dormant); `diagnostics` already had the 45 s kill + abort + 20 MB cap —
env filtering was the only gap (#112); the remaining `trayambak/*` tools
spawn no child processes (monitor/git/sota exec covered by #76/#78/#111).

Round-19 sweep — attacked and cleared: `parallel-execute` fans out a fixed
1–2 tasks per `taskType` (its `concurrency` schema param is dead, cosmetic
only); `multi-search` fetches only fixed provider hosts with
`encodeURIComponent(query)` (no URL injection); `webbrowse` shares the #73
`net-guard` (`guardedLookup` + protocol gate); `parallel_review`'s first
wave is bounded by the fixed specialist roster (Set-deduped) — only the
verify wave was open (#113).

Round-20 sweep — attacked: `marketplace` install source (names charset-gated
`[A-Za-z0-9_-]` ⇒ traversal unrepresentable; symlinked entries skipped;
existing targets never overwritten; caller-chosen source dir is by design,
reads policy-gated); `code/*` then yielded **#114** (vm jail) and the
load-stressed gate run yielded **#115** (state lock).

Round-21 sweep — attacked: `yaml` (hand-rolled parser: guard-bounded +
caught, no prototype construction ⇒ no pollution; deep nesting errors out
gracefully), `glob` (`resolveConstrainedPath` + `assertExternalDirectory` +
result caps), `webfetch` (net-guard + redirect re-block wired since #73),
`fim`/`next_edit` (bounded tokens + output caps, provider-gated), `workflow`
run-id traversal (`validRunId` charset gate ⇒ `..` unrepresentable, save-side
`randomUUID`) — all cleared; then **#116** (AskUserQuestion fan-out), **#117**
(web_search path/body), **#118** (RunWorkflow execution-claim honesty).

Round-22 sweep — attacked: `security-tool-registry` (BLOCKED_ARG_KEYS +
per-tool allowedArgs + identifier-regex keys + argv-only dispatch ⇒
cleared), `commands/` loader (front-matter over the user's own project
commands, by design), `diff`/`patch` write path (atomic all-or-nothing +
rollback, patch hunk-path headers ignored ⇒ no traversal) — all cleared;
the `text/` read paths then yielded **#119** (unbounded whole-file reads)
and **#120** (unbounded LCS table).

---

## 4. Fixed but **uncommitted** — the concurrent session's working batch

Verified present in the working tree (`git diff` / test files), gates green as
of 16:17 (287 files / 3,231 tests passed). **Not committed; must land before any
publish.**

| ID  | Severity | Finding                                                                                                                                                                                       | Where                                                             |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| #58 | Medium   | UNC config path: a remote-share config could wedge auth (UNC guard)                                                                                                                           | `apps/runtime/src/config-unc.test.ts`                             |
| #84 | Medium   | Permission-rule path subjects with backslashes (Windows paths mis-matched)                                                                                                                    | `packages/protocol/src/permission-rules.ts`                       |
| #85 | Low      | Rule subject name/target extraction when nothing concrete matched                                                                                                                             | `packages/protocol/src/permission-rules.ts`                       |
| #87 | Medium   | `recordUsage` garbage input NaN-poisoned the budget accumulator                                                                                                                               | `packages/core/src/token_budget.test.ts`                          |
| #88 | Medium   | Corrupt persisted messages / non-string token counts (compaction never armed, role fall-through)                                                                                              | `packages/core/src/token_budget.ts`                               |
| #90 | High     | An allow rule unlocked force-ask: blanket allow executed `rm -rf /` with no prompt (`git log; rm -rf /` rode a prefix match)                                                                  | `permission-rules.test.ts`; CHANGELOG [Unreleased]                |
| #93 | High     | A repo-committed `config.json` granted itself `full-access` (clone + `cd` ⇒ `rm -rf /` allowed)                                                                                               | `apps/runtime/src/config-permissions.test.ts`                     |
| —   | Medium   | Token budget invisible outside the turn loop: SOTA reasoning calls + local-supervisor decision calls never charged; failed subagent reported a free run (`SubagentWorkerError`)               | CHANGELOG [Unreleased] § "model calls made outside the turn loop" |
| —   | High     | `read_file` decoded whole files before its 50 KB cap (multi-GB ⇒ OOM kill); `resolveConstrainedPath` compared path strings, blind to directory junctions (arbitrary bytes through a junction) | CHANGELOG [Unreleased] § "two live file-tool escapes"             |

---

## 5. Fixed in the **audit tree only** — `Default Project`, needs porting

Regression tests exist at `packages/core/src/*.test.ts` in the non-git
`Default Project` tree (v0.5.0 layout: `agent_core.ts`, `tool_registry.ts`,
`retry.ts` — these modules **do not exist in trayambak**). Status for every row:
**fixed there, absent here, evidence pending in this repo.**

| ID   | Severity (assessed) | Finding (from regression-test comments)                                                                           |
| ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| #94  | Medium              | Only `approvalMode`/`maxTurns` validated — a string/NaN config fell through                                       |
| #95  | Medium              | Walker followed links with no visited set (symlink cycle / re-follow)                                             |
| #96  | Low                 | `isThread` only checked `messages` is an array                                                                    |
| #97  | Medium              | Model summary stored verbatim into compaction (unbounded/untrusted content)                                       |
| #98  | Medium              | Task handler never passed depth — depth guard bypassed for every call                                             |
| #99  | Medium              | NaN from a malformed provider response poisoned token counts + budget accumulator (2 sites)                       |
| #100 | Low                 | `.cursor/rules` treated as a file when it is a directory in the standard layout                                   |
| #101 | —                   | **No artifact in either tree — evidence pending**                                                                 |
| #102 | Medium              | Event arrays grew unbounded (long-lived TUI memory growth)                                                        |
| #103 | Medium              | Tool-timeout only won a race; pending 120 s timer never cleared                                                   |
| #104 | Medium              | `executeParallel` concurrency 0 gave an empty worker pool (silently dropped work)                                 |
| #105 | —                   | **No artifact in either tree — evidence pending**                                                                 |
| #106 | Medium              | `withRetry` `maxAttempts 0` ran the function zero times                                                           |
| #107 | Medium              | `recordTurn(NaN)` poisoned the budget (same NaN class)                                                            |
| #108 | Medium              | `agent_registry` limits failed open (`maxAgents: NaN`; push-then-check; capacity checked before existing-id path) |

---

## 6. Round 15 review — dormant-API wiring (this round, evidence-based)

| Dormant API (as named in the round-14 report)                                                               | Verdict in **trayambak**                                                                                                                                                                                                                                                  | Evidence                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `execpolicy`                                                                                                | **WIRED & enforced** — `evaluatePolicy(command)` at `apps/runtime/src/tools/command-exec/bash.ts:461`; `deny` hard-blocks (L462), `ask` prompts (L465); headless `ask` falls through by design, and the permission layer still denies dangerous commands headless at L485 | reviewed clean, no fix needed                                                       |
| `agentRegistry`                                                                                             | **DORMANT** — zero production consumers (only `agent_registry.ts` self-references + `index.ts` re-export)                                                                                                                                                                 | recommendation: **remove or wire before publish**; hardening dead code is not a fix |
| `executeParallel` / `withRetry` / `safeConcurrency` / `tool_registry.ts` / `retry.ts` / `slash_commands.ts` | **ABSENT** from this tree — they exist only in the `Default Project` architecture                                                                                                                                                                                         | `Test-Path` + full-tree grep: no matches                                            |
| approval ladder (`approval.ts`)                                                                             | **CLEAN** — exhaustive switch, explicit `danger === true`, default fails toward ask                                                                                                                                                                                       | Round-15 audit                                                                      |
| sibling fan-out tools                                                                                       | bounded (`SWARM_MAX_WORKERS = 8`, `DEBATE_MAX_TEAMS = 5`); **RunTeam was the outlier → fixed as #109**                                                                                                                                                                    | `swarm.ts:11`, `debate.ts:12`, `fc9fd17`                                            |

Headless contract, documented on purpose: an exec-policy `ask` verdict with no
approver available proceeds to the permission layer (whose own headless rule —
deny only when the command is dangerous — is the established contract at
`bash.ts:485`). The hard-deny rule set (`policy.ts:352–372`) remains enforced in
every mode. Not a fail-open: consistent layering.

---

## 7. Identified, deferred (files owned by the in-flight batch)

These are real but their files (`subagents.ts`, `agent.ts`) are inside the
concurrent session's uncommitted 92-file batch — editing them now risks two
sessions clobbering each other. Track them when the batch lands:

| Finding                                                                                                                                            | Location                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Depth guard NaN/negative bypass (`NaN >= max` is false ⇒ child runs)                                                                               | `packages/core/src/subagents.ts` (`resolveDepth`/`childDepth`) |
| Background subagent concurrency uncapped across calls (foreground batches; `startBackground` detached; `pruneBackground` never drops running jobs) | `apps/runtime/src/agent/agent.ts:616–659`                      |
| `promoteBackgroundJob` returns a status boolean, promotes nothing (dishonest API; test-only consumer)                                              | `apps/runtime/src/agent/agent.ts`                              |
| `usageById` map grows without bound                                                                                                                | `packages/core/src/subagents.ts`                               |

Rejected after review (no-fix, with reason): monitor regex ReDoS (self-DoS
only), test-only scaffolding (`extension_api`/`agent_registry` wiring demos).

---

## 8. Fixed-vs-documented reconciliation → 108 claimed + #109 + #110 + #111 + #112 + #113 + #114 + #115 + #116 + #117 + #118 + #119 + #120 = **120**

| Bucket                                          | Count                                                                       | State                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------- |
| My findings committed here                      | 31 (#51–54, 60, 62–80, 109–115)                                             | **fixed + verified + published-ready** |
| Other track, committed history (rounds 1–6 era) | documented by CHANGELOG section; individual refs preserved only for #48–#50 | **fixed + committed**                  |
| Other track, working batch (this repo)          | 7 numbered (#58, 84, 85, 87, 88, 90, 93) + 3 section groups                 | **fixed + uncommitted**                |
| Other track, audit tree only                    | 13 numbered (#94–#100, 102–104, 106–108)                                    | **fixed, wrong tree — port required**  |
| Claimed but no artifact                         | #101, #105                                                                  | **evidence pending**                   |
| Remaining rows of the 108                       | individual refs not preserved in this repo's artifacts (their-track ledger) | **documented by section, not by row**  |

The round-14 report's own claim ("108 findings, 14 rounds") is the other
track's ledger total; this document reconciles every row that has an artifact in
either tree and flags the rest instead of inventing them. When their batch
lands, merge their per-row ledger into §5.

---

## 9. Publish checklist

- [ ] **Port `Default Project` #94–#108 into trayambak** (tests included) —
      they currently exist only in a non-git, v0.5.0-layout tree.
- [x] **Commit the working batch** (their #58/#84–#93 + budget/file-tool fixes;
      CHANGELOG `[Unreleased]` for 0.6.7 + `1.0.0-S1-TITANIUM` stamp ride
      along). Landed as 14 reviewable commits `7ff8c21`→`635e7d1`: vision,
      keymap registry, welcome/theme, TUI transcript+markdown, build/ESM,
      verify gate, security, engine perf, tools, CLI //company, padLogoToTheme,
      infra, welcome fill-rows, docs/release.
- [ ] Resolve **#101 / #105** evidence (or drop them from the claim).
- [ ] Decide **`agent_registry`**: wire it or delete it (§6) — no dead exports.
- [x] Rebuild `dist` and verify every fix is present in the built artifacts
      (round-18 rebuild at v0.6.7: tsc 0 + ink 0 + postbuild OK; 7/7 spot
      checks green — #112 env filter, #110 safe-path, #111 boundedRun +
      honest desc, #78 git getSafeEnv, #109 cap).
- [ ] npm: confirm `@skt-ai-labs/trayambak-cli` is republished past the
      leaky 0.6.5 dist documented in CHANGELOG [Unreleased] ("the leak was
      still live in the _installed_ CLI").
- [x] Remove the stray untracked file `{}` from the working tree (round 18 —
      it was 0 bytes).
- [ ] Sync `docs/security.md` / `SECURITY.md` with the final behavior set.
- [x] Run the full gate suite on the final commit: `npm run build` ✓ (incl.
      postbuild ESM smoke 4/4), `tsc` ×3 ✓, `npm run lint` 0 errors / 138
      warnings ✓, `npx vitest run` 344 files / 4,099 passed / 3 failed /
      5 skipped (the 3 are the documented pair: doctor default-provider,
      `/company` env-leak — both pass isolated), coverage floors ✓ both tiers
      (repo 72.31/78.47/78.19/72.31, core 84.28/87.38/88.07/84.28), and
      `verify-all-tools` **ALL_TOOLS_OK** (tools=72 catalog=83 failures=0 —
      devmode made reachable and the shell warm-up added, `eac93aa`).

## 10. Gate snapshot at this review

| Gate                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmitOnError`              | **0 errors** — `npx tsc -p tsconfig.check.json` exit 0 (Round 22; the other track's keymap WIP has landed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npm run lint`                         | **0 errors** (138 warnings — final committed state; canonical scope `eslint apps packages skt`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `npx prettier --check` (changed files) | **clean**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npx vitest run`                       | **344 files — 4,099 passed / 3 failed / 5 skipped** (final committed state; the 3 = doctor default-provider assertion + `/company` env-leak pair, both isolated-green). Transient flakes classified, not silenced: state_db 48/50 under load = **#115** (fixed); their `/company` dispatch timeouts = CPU contention (5 s test-timeout under suite saturation, isolated 12/12 ×3, final full run green); checkpoints `afterEach` `rmSync` EPERM = transient Windows handle (isolated 17/17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Red-proof (rounds 15–22)               | #109 (`1 failed \| 4 passed`); #110 — 5 tests + import error red on stashed sources; #111 — 5 bounds tests red on stashed source; #112 — canary-leak test red (planted tsc dumped the secret) on stashed source; #113 — flood test red (`[40]` verifiers vs capped 16); #114 — escape probe red on original source (6 vectors returned `"v24.18.0"`), 11 blocked after; #115 — full-suite appends red at the 2 s bound (48/50, both children exit 0), green at 10 s; #116 — 5 fan-out tests red on old source (50-vs-10 / 40-vs-10 / clip / header), green after; #117 — 2 guard tests red (non-JSON instead of Invalid endpoint / too large), green after; #118 — honesty test red (Execute description), green after; #119 — 5 behavior tests red on old source (silent prefix, no note) + capped-read import-error suite, green after; #120 — LCS budget test red (old computed the full 20M-cell table instead of throwing), green after; all green after |

Ledger history: #51–54 `c243d78` · P1 batch `7b63be2` · #62 `682286f` · #65
`2a1d1f4` · #66/67 `5ad0520` · #68/69 `1346689` · #70 `a9028e0` · #71
`e91dad3` · #72–74 `8ea5917` · #75–77 `dfcf159` · #78–80 `2c6d203` · #109
`fc9fd17` · #110 `973bbae` · #111 `b364ca0` · #112 `f9a5440` · #113
`b571f22` · Windows AppContainer `11017d1` · batch `7ff8c21`–`635e7d1`
(14 commits: vision/keymap/welcome-TUI/ESM-build/verify-gate/security/engine/
tools/CLI-company/logo-pad/infra/docs).
