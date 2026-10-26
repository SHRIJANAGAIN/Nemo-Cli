# GitHub App (VPS) — setup guide

Run Nemo behind GitHub events: comment `/nemo <task>` on any issue
or PR and the agent replies on the thread. Read-only by default in spirit —
v1 only acts on explicit human comments, never on pushes or PR opens
(untrusted fork code + unattended runs = prompt-injection hole).

## 1. Register the App (browser, once)

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Name: `nemo` (or yours). Homepage: your VPS URL or repo URL.
3. Webhook: check **Active**, URL `https://YOUR-VPS/webhooks/github`,
   secret: generate one (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
4. Permissions (minimum): **Issues: read-write**, **Pull requests: read-write**,
   **Metadata: read-only**. Add **Contents: read-write** once you want the
   bot to write files / open PRs (self-service trial keys, `/nemo`
   fixes, autofix below — all need it).
5. Subscribe to events: **Issue comment** (and PR review comment, same switch).
5. Subscribe to events: **Issue comment** (and PR review comment, same switch).
6. Install it on your repo(s). Note the **App ID**; generate a **private key**
   (Downloads a `.pem` — VPS only, never the repo).

## 2. VPS env (you own this part)

```bash
GITHUB_WEBHOOK_SECRET=<hex from step 3>
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=/etc/nemo/github-app.pem   # path OR pasted PEM text
NEMO_GITHUB_WORKSPACE=/srv/nemo-work      # where the agent works
# Optional: GitHub Enterprise
# GITHUB_API_BASE=https://ghe.example.com/api/v3
```

Put them in `/etc/nemo/nemo.env` (mode 600) — see `.env.example`.
Restart the service: `sudo systemctl restart nemo`.

Without `GITHUB_WEBHOOK_SECRET` the route answers 503 (fail closed).
Without App credentials, jobs still run but results only land in the
server log with `[github-app] job done but no reply channel` — loud,
not silent.

## 3. Verify end to end

1. `curl http://127.0.0.1:8787/health` → `{"status":"ok",...}`
2. Open an issue, comment `/nemo say hi with the repo name`.
3. Watch `journalctl -u nemo -f` for `[github-app] job … started`.
4. The agent replies on the thread as `## Nemo result`.

## 4. Rules of the road

- Comment jobs never push to main: file writes the agent makes go through
  the github tool (API commits) or a fix branch + PR — humans merge.
- Edits to comments don't re-fire (only `created` actions run).
- Bodies over 1MB get HTTP 413; unknown events get 200+ignored (no retry storms).
- Keep the webhook secret + `.pem` off git. If either leaks: rotate in
  GitHub settings first, then on the VPS.

## 5. Automatic fixing (label-gated autopilot)

The bot watches issues by itself — no comment needed:

1. Label an issue `nemo` (or your `GITHUB_AUTOFIX_LABEL`).
2. Within one poll interval the server picks the oldest labeled, unhandled
   issue (one per tick), and the agent: reads it → creates branch
   `nemo/issue-N` → writes the fix via the API → opens a PR →
   comments the PR link on the issue.
3. You review + merge. The issue number runs once ever (ledger in
   `data/github-autofix.json`); retry via `/nemo` comment (ignores it).

Env:

```bash
GITHUB_AUTOFIX_REPOS=owner/repo,owner/other   # allowlist; "*" = every installed repo; empty = idle
GITHUB_AUTOFIX_LABEL=nemo                # the intent gate
GITHUB_AUTOFIX_INTERVAL_MIN=30                # 5..1440
# GITHUB_AUTOFIX_TRIAGE_COMMENT=              # custom greeting; empty disables triage greetings
```

Every tick the poller also **triages**: each new open issue (any label)
gets one static greeting comment — *"I can fix this — reply with the error
details…"* — inviting details and pointing at the label. No model spend,
no prompt-injection surface (the text is fixed), max 5 greetings per tick,
once per issue ever. Set `GITHUB_AUTOFIX_TRIAGE_COMMENT=` empty to turn
greetings off while keeping label-fixes on.

Safety, read twice: the label IS the approval (a human put it there),
fixes never touch the default branch, one job at a time, and every model
call burns your provider key — a busy label on a big repo spends money.
Start with one repo + a long interval.

## 6. CLI GitHub login (OAuth loop)

End users authorize from the TUI without ever handling tokens:

1. App settings → **Callback URL**: `https://YOUR-VPS/auth/github/callback`.
   Note the **Client ID**; generate a **Client secret** if you need one.
2. VPS env: `GITHUB_CLIENT_ID=<id>` + `GITHUB_CLIENT_SECRET=<secret>`.
3. CLI: `/github login` → browser opens the approve page → CLI polls and
   confirms. Then `/github issue <owner/repo#n>` reads through the server.
   `/github logout` forgets the token (also revocable in GitHub settings).
   Login persists your username into the CLI config, so the agent's system
   prompt always names its operator (GitHub login, license presence,
   machine) — no anonymous runs.

Every webhook job also appends one row to `data/github-jobs.jsonl`
(repo/issue/task-head/reply-head/error) — inspect via
`GET /admin/jobs?tail=100` (bearer). Server logs rotate; this doesn't.
