export * as TrayambakSessionResumeCommand from "./session-resume"

import { sessionManager } from "../session/session-manager.js"
import { sessionContinuation } from "../session/session-continuation.js"
import { failOutput } from "../command-registry.js"
import { isTranscriptTarget, loadTranscript, type TranscriptTarget } from "../session/resume-transcript.js"

export interface SessionResumeOptions {
  readonly sessionId: string
  readonly context?: Record<string, unknown>
}

/**
 * The transcript a `/resume` should hand the agent, or undefined when there is
 * nothing to hand over.
 *
 * Kept separate from the printed output so the dispatcher can pass `sessionFile`
 * through to `Agent` (which loads history via `Session.load`) instead of only
 * printing a confirmation.
 */
export function resolveResumeTarget(sessionId: string): TranscriptTarget | undefined {
  const result = loadTranscript(sessionId)
  return isTranscriptTarget(result) ? result : undefined
}

export function sessionResumeCommand(options: SessionResumeOptions): string {
  const session = sessionManager.get(options.sessionId)

  if (!session) {
    return failOutput(`Session ${options.sessionId} not found`)
  }

  const continuation = sessionContinuation.getContext(options.sessionId)

  if (continuation) {
    const resumed = sessionContinuation.resume(options.sessionId)
    if (resumed) {
      return `Resumed session ${options.sessionId} from ${resumed.context.interruptedAt.toISOString()}\n${resumed.message}`
    }
  }

  // The status flip is not a resume. The transcript has to be located and
  // verified, because resuming by id alone gave the model an empty session: the
  // id resolves in the metadata list, which carries no path to the conversation,
  // so the earlier turns were never loaded.
  const transcript = loadTranscript(options.sessionId)
  if (!isTranscriptTarget(transcript)) {
    return failOutput(`Cannot resume ${options.sessionId}: ${transcript.error}`)
  }

  sessionManager.update(options.sessionId, { status: "active" })

  return `Resumed session ${options.sessionId}: ${session.name} — ${transcript.messageCount} earlier message(s) restored from ${transcript.file}`
}
