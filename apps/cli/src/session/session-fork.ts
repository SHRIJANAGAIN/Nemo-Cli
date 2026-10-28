export * as NemoSessionForkFeature from "./session-fork"

import { sessionManager } from "./session-manager.js"

export interface ForkOptions {
  readonly parentId: string
  readonly name: string
  readonly agent?: string
}

export interface ForkResult {
  readonly parent: { id: string; name: string }
  readonly child: { id: string; name: string }
}

export function forkSession(options: ForkOptions): ForkResult | null {
  const parent = sessionManager.get(options.parentId)
  if (!parent) return null

  const child = sessionManager.fork(options.parentId, options.name)
  if (!child) return null

  if (options.agent) {
    sessionManager.update(child.id, { agent: options.agent })
  }

  return {
    parent: { id: parent.id, name: parent.name },
    child: { id: child.id, name: child.name },
  }
}

export function listSessions() {
  return sessionManager.list()
}

export function getSession(id: string) {
  return sessionManager.get(id)
}
