/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import * as vscode from "vscode"

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TrayambakViewProvider(context.extensionUri)
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("trayambak.sidebar", provider))
  context.subscriptions.push(
    vscode.commands.registerCommand("trayambak.run", async () => {
      const prompt = await vscode.window.showInputBox({ prompt: "Trayambak prompt" })
      if (prompt) vscode.window.showInformationMessage(`Trayambak queued: ${prompt.slice(0, 80)}`)
    }),
    vscode.commands.registerCommand("trayambak.openWeb", () => {
      vscode.env.openExternal(vscode.Uri.parse("http://127.0.0.1:8787/openapi.json"))
    }),
  )
}

class TrayambakViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly root: vscode.Uri) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true }
    view.webview.html = `<!doctype html><html><body>
      <h3>Trayambak</h3>
      <p>Terminal agent. Run <code>trayambak web</code> then <a href="http://127.0.0.1:8787/api/sessions">sessions</a>.</p>
      </body></html>`
  }
}

export function deactivate(): void {}
