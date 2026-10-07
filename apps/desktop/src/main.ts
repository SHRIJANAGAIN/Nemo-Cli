/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Trayambak desktop app (Electron): a chat window over the same Agent the
 * CLI/TUI/ACP server run — no protocol subprocess, the runtime is hosted
 * in the main process. Security posture: contextIsolation, no node
 * integration, renderer loaded from local files only, window.open denied.
 *
 * Run: `npm run desktop` (builds first), or `npm run desktop:quick` when
 * dist is current.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { Agent, loadConfig } from "../../../apps/runtime/src/index.js"
import { createAgentBridge, type BridgeAgent, type BridgeEvent } from "./bridge.js"

let win: BrowserWindow | null = null

/**
 * Renderer assets are plain files (not compiled): prefer the postbuild
 * copy inside dist/ (packaged layout), fall back to the source tree in
 * the dev repo where dist is wiped by every clean.
 */
function rendererHtml(): string {
  const fromDist = path.join(__dirname, "..", "renderer", "index.html")
  if (fs.existsSync(fromDist)) return fromDist
  return path.join(__dirname, "..", "..", "..", "..", "apps", "desktop", "renderer", "index.html")
}

const bridge = createAgentBridge({
  createAgent: async (cwd: string): Promise<BridgeAgent> => {
    const config = loadConfig({ cwd })
    return Agent.create({ config })
  },
  onEvent: (event: BridgeEvent): void => {
    win?.webContents.send("chat:event", event)
  },
})

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0f1115",
    title: "Trayambak",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // The chat is local-first: any target=_blank (markdown links) opens in
  // the system browser, never in a new app window with app privileges.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  void win.loadFile(rendererHtml())
  win.on("closed", () => {
    win = null
  })
}

ipcMain.handle("chat:prompt", async (_event, prompt: unknown): Promise<{ ok: true } | { error: string }> => {
  if (typeof prompt !== "string" || prompt.trim().length === 0) return { error: "empty prompt" }
  try {
    await bridge.send(prompt)
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
})

ipcMain.on("chat:cancel", () => {
  bridge.cancel()
})

ipcMain.handle("chat:chooseFolder", async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })
  const dir = result.filePaths[0]
  if (dir !== undefined && !result.canceled) bridge.setWorkspace(dir)
  return dir ?? null
})

ipcMain.handle("chat:workspace", () => bridge.workspace())

app.whenReady().then(() => {
  // Dev runs start in the repo; a launched desktop app starts at home and
  // the folder picker moves it (workspace defaults matter: tools run there).
  bridge.setWorkspace(process.cwd())
  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
