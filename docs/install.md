# Install & distribution

Truthful status: Trayambak ships as Node.js + npm + ready-made shims today.
There is no single-file binary yet.

## Install

macOS / Linux / WSL / Git Bash:

```bash
./install.sh
# then: trayambak  (short alias: skt)
```

Windows (PowerShell, from the repo root):

```powershell
.\install.ps1
```

What the scripts do: check `node >= 18`, `npm install`, `npm run build`,
then link `trayambak` / `skt` launchers (`~/.local/bin` on Unix,
`~/bin/*.cmd` shims + `TRAYAMBAK_HOME` on Windows).

Other routes: `npm install -g @skt-ai-labs/trayambak-cli`, Docker
(`Dockerfile`, entry `node dist/apps/cli/src/index.js`), `trayambak upgrade`.

## Single-file binary

Not shipped. A Node SEA (single-executable) build is the tracked path
(single `trayambak` file, no Node install needed), pending a bundler +
postject injection step in CI. Until then, any claim of a standalone binary
is false — install scripts above are the supported route.
