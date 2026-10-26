# Sessions

How Nemo stores, lists, resumes, and cleans up conversation sessions.
Grounded in `packages/session-backends/src/transcript.ts` (transcripts),
`apps/cli/src/session/session-manager.ts` (the index), and
`apps/cli/src/commands/archive.ts` (the CLI verbs).

## On-disk layout

Two separate stores under `~/.nemo/`:

```
~/.nemo/
├── sessions.json                     # index of named sessions (SessionManager)
└── sessions/
    ├── <uuid>/                       # one transcript per session
    │   ├── context.jsonl             # message history, one JSON record per line
    │   ├── wire.jsonl                # event log { t, event } per line
    │   └── state.json                # { title, updatedAt, workDir, customTitle? }
    ├── .archived/<uuid>/             # archived sessions (same shape)
    └── <uuid>.jsonl                  # legacy single-file layout (auto-migrated)
```

| Concern          | Detail                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Root override    | `NEMO_SESSIONS_DIR` changes `sessions/`; `NEMO_SESSIONS_FILE` changes `sessions.json`                                                |
| Permissions      | `state.json` is written atomically with `0600` (tmp + rename); `context.jsonl` / `wire.jsonl` are append-only                                  |
| Titles           | The first user message becomes the title (first 50 chars) unless you set a custom one                                                          |
| Empty sessions   | Sessions with no content are skipped when listing (never shown as ghosts)                                                                      |
| Legacy migration | `<id>.jsonl` is renamed to `<id>/context.jsonl` on demand                                                                                      |
| Index            | `sessions.json` holds at most 500 loaded entries; a corrupt index is set aside as `sessions.json.corrupt-<timestamp>` and the CLI starts clean |

## Inside the session (slash commands)

| Command                                     | What it does                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sessions`, `/resume`                      | Open the session picker                                                                                                                         |
| `/newchat`                                  | Start a new conversation (detaches from the current session id)                                                                                 |
| `/clear`                                    | Reset the session                                                                                                                               |
| `/history`                                  | Session name, message count, start time                                                                                                         |
| `/search <text>`                            | Grep this session's transcript (results are shown, nothing is persisted)                                                                        |
| `/stats`                                    | Message counts by role / token count                                                                                                            |
| `/copy`, `/copy last`                       | Copy the transcript (or just the last reply) to the clipboard                                                                                   |
| `/compact`                                  | Force context compaction — prune/truncate/fold old history                                                                                      |
| `/undo`, `/redo`                            | Restore / re-apply the previous workspace checkpoint (`Ctrl+Z` / `Ctrl+Y`)                                                                      |
| `/checkpoint on\|off\|status`               | Checkpoint master switch (default **on**: a capture happens before every turn)                                                                  |
| `/checkpoints`                              | List stored points (`/checkpoints prune confirm` deletes all)                                                                                   |
| `/queue`, `/queue clear`, `/queue drop <n>` | Prompts queued while the agent runs                                                                                                             |
| `/forget`, `/forget confirm`                | Mark session history for deletion                                                                                                               |
| `/memory`                                   | List persistent memory entries (auto-extract is on by default, max 2 keeper facts per turn; disable with config key `memoryAutoExtract: false`) |
| `/cron`                                     | List scheduled cron jobs (the model creates them; a 60s scheduler fires them)                                                                   |
| `/status`                                   | Model, session, tokens, uptime                                                                                                                  |

### The session picker

`/sessions` (or `/resume`) opens the picker with these keys (from
`SessionPicker.tsx`):

| Key      | Action                                                |
| -------- | ----------------------------------------------------- |
| `Enter`  | Resume the selected session                           |
| `r`      | Rename it                                             |
| `d`      | Delete it                                             |
| `F`      | Fork it — a new session derived from the selected one |
| `Ctrl+A` | Archive it                                            |
| `Esc`    | Close the picker                                      |

> **Note:** `/fork` in the REPL is _not_ session forking — it spawns a
> fire-and-forget **background subagent** with this turn's context (watch it
> with `/background`, `Ctrl+B`). Session forking is the `F` key in the picker
> above.

## From the command line

```sh
nemo archive <id>       # move sessions/<id>/ -> sessions/.archived/<id>/
nemo unarchive <id>     # move it back
nemo delete <id>        # remove sessions/<id>/ and .archived/<id>/ (recursive, forced)
```

Each prints `archived <id>` / `unarchived <id>` / `deleted <id>`, or an error
like `session not found: <id>`.

Other session-related flags:

| Flag                         | Effect                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `nemo --session <file>` | Persist the session transcript to a JSON file (also passed to the REPL as `NEMO_SESSION`) |
| `nemo exec "…"`         | Stateless single prompt — events stream to stdout, nothing is resumed next run                 |
| `nemo run "…"`          | Interactive session that runs that prompt on launch                                            |

## Compaction

Context compaction keeps long sessions within the model's window
(`contextWindow`, default 128 000 tokens; proactive compaction is driven by
it).

```sh
nemo compact config     # maxTokens / targetTokens / preserveRecent
nemo compact estimate   # would this session compact?
nemo compact run        # run compaction over the store
nemo compact reset      # reset compaction state
```

In the REPL, `/compact` does it for the live session.

## Other surfaces that see your sessions

| Surface                   | What it exposes                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `nemo web`           | `GET /api/sessions` returns the transcript list (see [Web](web.md))                 |
| `nemo acp`           | `new_session`, `load_session`/`resume_session`, `list_sessions` (see [ACP](acp.md)) |
| `/api/sessions` over HTTP | Same transcript index — token-protected when a token is configured                  |

## Related

- [Getting started](getting-started.md) — CLI commands and configuration.
- [Security](security.md) — file permissions and what never leaves the machine.
- [Troubleshooting](troubleshooting.md) — recovering a corrupt session index.
