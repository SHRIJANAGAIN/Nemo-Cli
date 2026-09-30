/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */
import * as vscode from "vscode"

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TrayambakViewProvider(context.extensionUri)
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("trayambak.sidebar", provider))
  const sessions = new TrayambakSessionsProvider()
  const models = new TrayambakModelsProvider()
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("trayambak.sessions", sessions),
    vscode.window.registerTreeDataProvider("trayambak.models", models),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("trayambak")) models.refresh()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("trayambak.run", async () => {
      const prompt = await vscode.window.showInputBox({ prompt: "Trayambak prompt" })
      if (prompt) vscode.window.showInformationMessage(`Trayambak queued: ${prompt.slice(0, 80)}`)
    }),
    vscode.commands.registerCommand("trayambak.openWeb", () => {
      vscode.env.openExternal(vscode.Uri.parse("http://127.0.0.1:8787/openapi.json"))
    }),
    vscode.commands.registerCommand("trayambak.switchModel", async () => {
      const model = await vscode.window.showInputBox({ prompt: "Model id (empty = provider default)" })
      if (model !== undefined) {
        await vscode.workspace.getConfiguration("trayambak").update("model", model, /*global*/ true)
        vscode.window.showInformationMessage(model ? `Trayambak model: ${model}` : "Trayambak model: default")
      }
    }),
    vscode.commands.registerCommand("trayambak.switchProvider", async () => {
      const picked = await vscode.window.showQuickPick(
        [
          "nvidia",
          "openai",
          "anthropic",
          "google",
          "xai",
          "huggingface",
          "ollama",
          "groq",
          "mistral",
          "openrouter",
          "custom",
          "llamacpp",
        ],
        { placeHolder: "Trayambak provider" },
      )
      if (picked) {
        await vscode.workspace.getConfiguration("trayambak").update("provider", picked, /*global*/ true)
        vscode.window.showInformationMessage(`Trayambak provider: ${picked}`)
      }
    }),
    vscode.commands.registerCommand("trayambak.compact", () => {
      vscode.window.showInformationMessage("Trayambak: run /compact in the terminal session to free tokens.")
    }),
    vscode.commands.registerCommand("trayambak.review", () => {
      const sel = vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection)
      vscode.window.showInformationMessage(
        sel && sel.length > 0
          ? `Trayambak review queued (${sel.length} chars).`
          : "Select code, then Trayambak: Review.",
      )
    }),
    vscode.commands.registerCommand("trayambak.newSession", () => {
      vscode.window.showInformationMessage("Trayambak: run /newchat in the terminal session.")
    }),
    vscode.commands.registerCommand("trayambak.openSessions", () => {
      vscode.env.openExternal(vscode.Uri.parse("http://127.0.0.1:8787/api/sessions"))
    }),
  )
  // Local-only ghost-text: completes the current word from visible
  // document text. No network, no provider call — privacy-preserving.
  const inline = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: "**" },
    {
      provideInlineCompletionItems(doc, pos): vscode.InlineCompletionList {
        if (vscode.workspace.getConfiguration("trayambak").get("inlineCompletion") === false) {
          return new vscode.InlineCompletionList([])
        }
        const line = doc.lineAt(pos.line).text.slice(0, pos.character)
        const m = line.match(/[A-Za-z0-9_]{3,}$/)
        if (!m) return new vscode.InlineCompletionList([])
        const prefix = m[0]
        const text = doc.getText()
        const seen = new Set<string>()
        const items: vscode.InlineCompletionItem[] = []
        const wordRe = new RegExp(`\\b${prefix}[A-Za-z0-9_]+`, "g")
        let hit: RegExpExecArray | null
        while ((hit = wordRe.exec(text)) !== null && items.length < 3) {
          if (hit[0] !== prefix && !seen.has(hit[0])) {
            seen.add(hit[0])
            items.push(new vscode.InlineCompletionItem(hit[0].slice(prefix.length)))
          }
        }
        return new vscode.InlineCompletionList(items)
      },
    },
  )
  context.subscriptions.push(inline)
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  status.text = "$(sparkle) Trayambak"
  status.command = "trayambak.run"
  status.tooltip = "Trayambak agent"
  status.show()
  context.subscriptions.push(status)
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

/** Sessions view: local-only links into the CLI session store. No network calls from the extension host. */
class TrayambakSessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly change = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.change.event

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): vscode.TreeItem[] {
    const open = new vscode.TreeItem("Open sessions", vscode.TreeItemCollapsibleState.None)
    open.command = { command: "trayambak.openSessions", title: "Open sessions" }
    open.tooltip = "Browse transcripts via trayambak web."
    const fresh = new vscode.TreeItem("New session (/newchat)", vscode.TreeItemCollapsibleState.None)
    fresh.command = { command: "trayambak.newSession", title: "New session" }
    const note = new vscode.TreeItem("Sessions live in the CLI store", vscode.TreeItemCollapsibleState.None)
    note.tooltip = "The extension never copies transcripts; run trayambak web to browse them."
    return [open, fresh, note]
  }

  refresh(): void {
    this.change.fire()
  }
}

/** Models view: shows the configured provider/model with switch actions. Reads workspace config only. */
class TrayambakModelsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly change = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.change.event

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  getChildren(): vscode.TreeItem[] {
    const cfg = vscode.workspace.getConfiguration("trayambak")
    const providerId = cfg.get<string>("provider") || "nvidia"
    const model = cfg.get<string>("model") || "(provider default)"
    const current = new vscode.TreeItem(`${providerId} / ${model}`, vscode.TreeItemCollapsibleState.None)
    current.tooltip = "Active provider and model from the trayambak.* settings."
    const switchProvider = new vscode.TreeItem("Switch provider", vscode.TreeItemCollapsibleState.None)
    switchProvider.command = { command: "trayambak.switchProvider", title: "Switch provider" }
    const switchModel = new vscode.TreeItem("Switch model", vscode.TreeItemCollapsibleState.None)
    switchModel.command = { command: "trayambak.switchModel", title: "Switch model" }
    return [current, switchProvider, switchModel]
  }

  refresh(): void {
    this.change.fire()
  }
}

export function deactivate(): void {}
