export * as TrayambakSessionResumeCommand from "./session-resume"

import { sessionManager } from "../session/session-manager.js"
import { sessionContinuation } from "../session/session-continuation.js"

export interface SessionResumeOptions {
  readonly sessionId: string
  readonly context?: Record<string, unknown>
}

export function sessionResumeCommand(options: SessionResumeOptions): string {
  const session = sessionManager.get(options.sessionId)

  if (!session) {
    return `Session ${options.sessionId} not found`
  }

  const continuation = sessionContinuation.getContext(options.sessionId)

  if (continuation) {
    const resumed = sessionContinuation.resume(options.sessionId)
    if (resumed) {
      return `Resumed session ${options.sessionId} from ${resumed.context.interruptedAt.toISOString()}\n${resumed.message}`
    }
  }

  sessionManager.update(options.sessionId, { status: "active" })

  return `Resumed session ${options.sessionId}: ${session.name}`
}
