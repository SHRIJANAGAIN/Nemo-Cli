# VS Code extension (scaffold)

`apps/vscode-extension/` — sidebar webview + `trayambak.run` / `trayambak.openWeb` commands.
Build separately (`tsc -p apps/vscode-extension/tsconfig.json` after `npm i -D @types/vscode`); excluded from root typecheck until then.
Status: scaffold — sidebar renders, commands registered, webview links to `trayambak web` API. Not yet published to marketplace.
