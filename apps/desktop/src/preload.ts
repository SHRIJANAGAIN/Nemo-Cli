/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * Context-isolated preload: the renderer gets a minimal, typed chat API
 * and never touches `ipcRenderer` or Node directly (contextIsolation on,
 * nodeIntegration off — see main.ts webPreferences).
 */

import { contextBridge, ipcRenderer } from "electron"

export interface DesktopChatApi {
  prompt(text: string): Promise<{ ok: true } | { error: string }>
  cancel(): void
  chooseFolder(): Promise<string | null>
  /** Current workspace cwd the agent runs tools in. */
  workspace(): Promise<string>
  /** Subscribes to agent events; returns an unsubscribe function. */
  onEvent(callback: (event: unknown) => void): () => void
}

const api: DesktopChatApi = {
  prompt: (text: string) => ipcRenderer.invoke("chat:prompt", text),
  cancel: () => ipcRenderer.send("chat:cancel"),
  chooseFolder: () => ipcRenderer.invoke("chat:chooseFolder"),
  workspace: () => ipcRenderer.invoke("chat:workspace"),
  onEvent: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_electronEvent: unknown, event: unknown): void => callback(event)
    ipcRenderer.on("chat:event", handler)
    return () => {
      ipcRenderer.removeListener("chat:event", handler)
    }
  },
}

contextBridge.exposeInMainWorld("trayambak", api)
