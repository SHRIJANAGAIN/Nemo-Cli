export * as NemoSessionContinuation from "./session-continuation"

export interface ContinuationContext {
  readonly sessionId: string
  readonly lastMessageId: string
  readonly interruptedAt: Date
  readonly reason?: string
}

export interface ContinuationResult {
  readonly resumed: boolean
  readonly context: ContinuationContext
  readonly message?: string
}

export class SessionContinuation {
  private continuations: Map<string, ContinuationContext> = new Map()

  markInterrupted(context: ContinuationContext): void {
    this.continuations.set(context.sessionId, context)
  }

  canContinue(sessionId: string): boolean {
    return this.continuations.has(sessionId)
  }

  getContext(sessionId: string): ContinuationContext | undefined {
    return this.continuations.get(sessionId)
  }

  resume(sessionId: string): ContinuationResult | null {
    const context = this.continuations.get(sessionId)
    if (!context) return null

    this.continuations.delete(sessionId)

    return {
      resumed: true,
      context,
      message: `[TASK RESUMPTION] Resuming from ${context.interruptedAt.toISOString()}`,
    }
  }

  clear(sessionId: string): boolean {
    return this.continuations.delete(sessionId)
  }
}

export const sessionContinuation = new SessionContinuation()
