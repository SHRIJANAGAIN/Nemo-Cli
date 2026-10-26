# VS Code extension (scaffold)

`apps/vscode-extension/` — sidebar webview + `nemo.run` / `nemo.openWeb` commands.
Build separately (`tsc -p apps/vscode-extension/tsconfig.json` after `npm i -D @types/vscode`); excluded from root typecheck until then.
Status: scaffold — sidebar renders, commands registered, webview links to `nemo web` API. Not yet published to marketplace.
