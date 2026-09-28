# GitHub App (VPS) — setup guide

Run Trayambak behind GitHub events: comment `/trayambak <task>` on any issue
or PR and the agent replies on the thread. Read-only by default in spirit —
v1 only acts on explicit human comments, never on pushes or PR opens
(untrusted fork code + unattended runs = prompt-injection hole).

## 1. Register the App (browser, once)

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Name: `trayambak` (or yours). Homepage: your VPS URL or repo URL.
3. Webhook: check **Active**, URL `https://YOUR-VPS/webhooks/github`,
   secret: generate one (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
4. Permissions (minimum): **Issues: read-write**, **Pull requests: read-write**,
   **Metadata: read-only**. No contents access in v1 (the agent works in a
   local checkout, it never pushes).
5. Subscribe to events: **Issue comment** (and PR review comment, same switch).
6. Install it on your repo(s). Note the **App ID**; generate a **private key**
   (Downloads a `.pem` — VPS only, never the repo).

## 2. VPS env (you own this part)

```bash
GITHUB_WEBHOOK_SECRET=<hex from step 3>
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY=/etc/trayambak/github-app.pem   # path OR pasted PEM text
TRAYAMBAK_GITHUB_WORKSPACE=/srv/trayambak-work      # where the agent works
# Optional: GitHub Enterprise
# GITHUB_API_BASE=https://ghe.example.com/api/v3
```

Put them in `/etc/trayambak/trayambak.env` (mode 600) — see `.env.example`.
Restart the service: `sudo systemctl restart trayambak`.

Without `GITHUB_WEBHOOK_SECRET` the route answers 503 (fail closed).
Without App credentials, jobs still run but results only land in the
server log with `[github-app] job done but no reply channel` — loud,
not silent.

## 3. Verify end to end

1. `curl http://127.0.0.1:8787/health` → `{"status":"ok",...}`
2. Open an issue, comment `/trayambak say hi with the repo name`.
3. Watch `journalctl -u trayambak -f` for `[github-app] job … started`.
4. The agent replies on the thread as `## Trayambak result`.

## 4. Rules of the road

- The App never pushes code in v1 — it comments. Commit-back is a later,
  explicitly-gated phase.
- Edits to comments don't re-fire (only `created` actions run).
- Bodies over 1MB get HTTP 413; unknown events get 200+ignored (no retry storms).
- Keep the webhook secret + `.pem` off git. If either leaks: rotate in
  GitHub settings first, then on the VPS.
