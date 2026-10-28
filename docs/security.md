# Security

Security-relevant behaviour of the CLI, verified in source. To **report** a
vulnerability, read [`SECURITY.md`](../SECURITY.md) (SLA, scope, disclosure
window) first — do not open a public issue.

## Local-first data handling

- **No telemetry.** The telemetry package is gone: there is no sink, no
  analytics upload and no opt-in switch, so **nothing is recorded or sent**.
- Prompts and code leave the machine only when you configure a **remote
  provider** (`baseUrl` + `apiKey`) or a **remote MCP server**. A local
  llama.cpp/Ollama setup keeps everything on-disk.
- Browser automation is **off** by default
  (`browserAutomationEnabled: false`).

Things to review before running an untrusted prompt:

| Surface                 | Variable / setting                                                  |
| ----------------------- | ------------------------------------------------------------------- |
| Local model binary      | `NEMO_LLAMACPP_BIN` + GGUF source (`NEMO_MODEL_PATH`)     |
| Working directory       | `NEMO_CWD` / `--cwd`                                           |
| MCP servers             | `NEMO_MCP_SERVERS` / `mcpServers` config                       |
| Tool hooks              | `hooks.preToolUse` / `hooks.postToolUse` (arbitrary shell commands) |
| Skills & agent profiles | `NEMO_SKILLS_DIR`, `NEMO_AGENT_PROFILE_DIRS`              |

## Secret storage

| Secret                                      | Location                                                       | Protection                                      |
| ------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| API key (`nemo login`)                 | `~/.nemo/credentials.json` (`NEMO_CREDENTIALS_FILE`) | `0600`, atomic tmp + rename                     |
| Config incl. `apiKey`, `providers[].apiKey` | `./.nemo/config.json` or `~/.nemo/config.json`       | `0600`, atomic; previous file rotates to `.bak` |
| Session transcripts & index                 | `~/.nemo/sessions*`, `sessions.json`                      | `0600`                                          |
| MCP OAuth tokens                            | `~/.nemo/mcp-auth.json` (`NEMO_MCP_AUTH_FILE`)       | `0600`                                          |

- Prefer **`NEMO_API_KEY`** (per-process env var) over a key in
  `config.json` on shared hosts; there is **no OS keychain integration yet**.
- Keys pasted with prefixes (`NVAPI_KEY …`, `Bearer …`, `KEY=…`) are stripped
  at load but stored clean — **rotate** any key that was ever committed or
  screenshared (see [Providers](providers.md#key-hygiene--cleanapikey)).
- Keep `~/.nemo/` itself `0700`. Never commit `mcp-auth.json`; revoke
  with `nemo mcp logout <name>`.

## Permission model

Defined in `packages/protocol/src/permissions.ts`; three layers, **deny wins**:

1. **Explicit deny rules** are checked first and always win
   (`isCommandDangerous`). Defaults deny (bash):
   `rm -rf /`, `rm -rf ~`, `rm -rf .`, `del /s /q`, `format`, `shutdown`,
   `reboot`, `sudo`, `su` — plus (from `config.ts`) `write_file *` and
   `edit_file *` pending approval.
2. **Read-only tools never need approval** — `read_file`, `list_dir`, `glob`,
   `grep`, `code_search`, `read_manifest`, `web_search`, `web_fetch`,
   `web_browse`, `memory`, `todo`, `summarize`, `extract`, `diff`, `csv`,
   `yaml`, `artifact`, `get_mode`, `tool_search`.
3. **Everything else asks** while `askByDefault` is `true` (the default). The
   bash tool (`apps/runtime/src/tools/command-exec/bash.ts`) re-checks every
   command with `isCommandAllowed()` before running it.
4. **Force-ask gates deletes, always** (`DELETE_FORCE_ASK_RULES` in
   `packages/protocol/src/permission-rules.ts`): recursive deletes (`rm -rf`,
   `del /s /q`, `Remove-Item -Recurse -Force`) and disk formats (`format`,
   `mkfs`). In `auto-approve` mode ONLY these can still ask — `sudo`,
   `shutdown`/`reboot`, `git push --force`, `dd if=`, and pipe-to-shell
   downloads auto-allow. In `full-access` nothing blocks at all (explicit
   user choice to run unguarded). Your own session/config `deny` rules
   still gate under every mode except full-access.

You can add your own tri-state rules (`rulesV2`: `allow` / `ask` / `deny`
with tool + pattern globs) via config; they are evaluated **before** the
legacy rules.

**`.agentignore` (per-project credential deny-list):** one glob per line in
`<cwd>/.agentignore` (`#` comments, blanks ignored) becomes config-layer
`deny` rules for every tool — `*.pem`, `.env`, `secrets/` and friends can
never be read, written, or executed, in any mode except explicit
full-access. No `!` negation in v1 (deny beats allow within a layer, so an
exception could never win — documented, not half-honored).

### Modes

| Where                        | Values                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| TUI `/permissions` (UI mode) | `read-only`, `plan`, `ask` (default), `auto-approve`, `full-access`                |
| TUI `/mode`                  | Mode stack: `/mode <name>` switches, `/mode exit` returns                          |
| Config `permissions.mode`    | `default`, `coder`, `yolo`, `browser`, `planner` (`yolo` == `askByDefault: false`) |

`full-access` disables all approvals — nothing can block (audit `permissions`
before using it, and read the [Sandbox](#sandbox) section first).
`auto-approve` allows everything except deletes (`rm -rf`, `del /s /q`,
`Remove-Item -Recurse -Force`, `format`, `mkfs`) and your own explicit
deny rules, which still gate.

## Sandbox

`packages/sandbox/src/index.ts` — in-process policy engine:

| Policy               | Meaning                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `danger-full-access` | Everything allowed                                                                     |
| `read-only`          | Reads only; writes denied                                                              |
| `workspace-write`    | Writes limited to `writableRoots` (and cwd); `readOnlySubpaths` carve-outs; reads free |
| `external-sandbox`   | Reads allowed, writes denied                                                           |

| Backend                          | How it is detected                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seatbelt`                       | darwin **and** `/usr/bin/sandbox-exec` actually exists                                                                                                    |
| `bwrap` (bubblewrap)             | linux **and** `/usr/bin/bwrap` actually exists                                                                                                            |
| `fallback`                       | anything else — the honest default (incl. Windows today)                                                                                                  |
| `windows-restricted`, `landlock` | implemented in `spawn.ts` behind `FEATURE_SANDBOXSPAWN`, but **`detectBackend()` never returns them** — it yields only `seatbelt`, `bwrap`, or `fallback` |

**Honesty note:** with the `sandboxSpawn` feature flag at its default
(`true`), backends with a real isolator (`seatbelt`, `bwrap`) engage OS
isolation and report `"os-sandbox"`; everywhere else (including Windows
today) every check reports `enforcement: "policy-only"` — in-process
policy evaluation, no OS sandbox process is spawned, so the backend name
describes the available _integration point_, not kernel-level isolation.
Setting `FEATURE_SANDBOXSPAWN=0` forces `"policy-only"` everywhere —
`enforcementFor()` and `describeEnforcement()` share one source of truth,
so the label always matches what is actually enforced.
Actual command/file enforcement in the runtime comes from the
agent-loop permission gate (`packages/protocol/src/permission-rules.ts`);
deny rules are an absolute veto and "ask" routes to an interactive
approver (headless never auto-approves).

Try it from the shell:

```sh
nemo sandbox check ./src/index.ts   # "allow (backend, policy-only)" or "deny (...): reason"
nemo sandbox                        # prints backend + enforcement mode
nemo execpolicy check "rm -rf /"    # "deny (rm -rf /*)"
nemo execpolicy check "npm test"    # "allow" (no rule matched)
```

`sandbox check` evaluates a `workspace-write` policy rooted at the current
directory. `execpolicy check` runs the ordered glob rule list
(`DEFAULT_EXEC_RULES`: `rm -rf /*`, `rm -rf ~*`, `format`, `shutdown`,
`reboot*`, `poweroff*`, `mkfs*`, `sudo *`, `dd *of=*`, `reg delete *`,
`vssadmin *`, pipe-to-shell `* | sh` / `* | bash` variants, PLUS the full
protocol force-ask corpus derived live from `FORCE_ASK_RULES` — `git push
--force`, `del /s /q`, `Remove-Item -Recurse -Force`, `iex`,
`eval(`, … — so the display gate can never disagree with the approval
ladder) — first match wins, and **commands matching no rule are allowed**.
Chained commands are split on `;`, `&&`, `||`, `&` and newlines first (lone
`|` is never a split point — pipe-to-shell patterns need it), so `echo ok;
mkfs /dev/sda` is judged by its `mkfs` segment, not its `echo` wrapper.

### User `.rules` files (discovery + merge precedence)

`nemo execpolicy check` evaluates the display list above, but the
gate every `bash` call passes is `PolicyManager.evaluate` in
`packages/execpolicy`, and on **first** construction that manager
discovers a user `.rules` file in this order:

1. `<cwd>/.nemo/policy.rules` (the project copy wins)
2. `~/.nemo/policy.rules` (the user's home copy)

The file is loaded **merged over the defaults, never instead of them**:
`rules = [...getDefaultPolicy().rules, ...fileRules]`, with
`networkRules` concatenated the same way. Consequences, each covered by
tests in `packages/execpolicy/src/policy.test.ts`:

- A file can only **add** rules; the ten built-in denies always stay.
- `evaluate` runs its deny pass over every rule before its allow pass,
  so a file line `sudo * allow` still loses to the default `sudo *`
  deny: a user file can widen what is allowed, never un-deny.
- A line with no `allow`/`deny`/`ask` keyword parses as **deny** for
  that exact pattern (fail-closed parse), and hot reload re-applies the
  same merge, so editing the file can never drop a default deny.
- No file - or an unreadable one - means the built-in default policy,
  unchanged from before this discovery existed.

`PolicyManager.load(file)` keeps its original "the file replaces the
policy" semantics for programmatic callers; only `loadUserPolicy()` and
first-construction discovery merge.

## Hooks

`config.hooks` runs shell commands around tool calls:

- `preToolUse` — can **block or escalate to ask** before a tool runs
  (matcher groups select tool names).
- `postToolUse` — appends context after the call.
- Sanitised on load: max 20 matcher groups × 20 hooks, command ≤ 2000 chars,
  `timeoutSec` clamped 1–120. Malformed hooks are dropped, never fatal.

Treat any `hooks` entry you did not write as code execution — it is.

## Updates & supply chain

- Tag-triggered CI releases publish with `--provenance` (attestation); a
  local `npm run publish:npm` publishes unattested. `npm run sbom` emits
  `sbom.cyclonedx.json`.
- The tarball is built by `scripts/make-publish.mjs` with a `files` allowlist
  (`["dist", "Img"]`) so source can never ship by accident.
- `NEMO_SKIP_OBFUSCATION=1` (or `--skip-obfuscation`) produces a debuggable publish build. The
  default obfuscation is **size/hygiene only — never a security boundary**.
- Auto-update policy: `NEMO_AUTOUPDATE` (`true`/`1`, `false`/`0`,
  `notify`) and the `NEMO_DISABLE_AUTOUPDATE` kill switch (anything but
  `0`/`false` skips the check).
- The llama.cpp binaries bundled for local serving live in `bin/` alongside
  their upstream licence files.

## Network exposure at a glance

| Feature                | Default exposure                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CLI / REPL             | none (outbound provider calls only)                                                                                   |
| `nemo web`        | `127.0.0.1:8787`; no auth on loopback; **non-loopback binds auto-generate a token (fail closed)** — see [Web](web.md) |
| `nemo acp`        | stdio only                                                                                                            |
| `nemo mcp-server` | stdio only (and `tools/call` is a stub today)                                                                         |
| `nemo serve`      | llama.cpp server — loopback port by default                                                                           |

## Related

- [`SECURITY.md`](../SECURITY.md) — supported versions, reporting SLA, scope.
- [Providers](providers.md) — where requests are sent.
- [Sessions](sessions.md) — what is written to disk.
- [Troubleshooting](troubleshooting.md) — diagnosing misconfiguration.
