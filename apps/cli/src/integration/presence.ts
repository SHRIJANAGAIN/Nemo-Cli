export * as NemoPresence from "./presence"

export interface PresenceState {
  readonly userId: string
  readonly status: "online" | "away" | "busy" | "offline"
  readonly lastSeen: Date
  readonly currentSession?: string
}

export interface PresencePolicy {
  readonly idleTimeout: number
  readonly awayTimeout: number
  readonly broadcastInterval: number
}

export class PresenceService {
  private state: PresenceState = {
    userId: "local",
    status: "online",
    lastSeen: new Date(),
  }
  private policy: PresencePolicy = {
    idleTimeout: 300000,
    awayTimeout: 600000,
    broadcastInterval: 30000,
  }
  private listeners: Set<(state: PresenceState) => void> = new Set()

  getState(): PresenceState {
    return this.state
  }

  setStatus(status: PresenceState["status"]): void {
    this.state = { ...this.state, status, lastSeen: new Date() }
    this.notifyListeners()
  }

  setCurrentSession(sessionId: string): void {
    this.state = { ...this.state, currentSession: sessionId }
    this.notifyListeners()
  }

  getPolicy(): PresencePolicy {
    return this.policy
  }

  setPolicy(policy: Partial<PresencePolicy>): void {
    this.policy = { ...this.policy, ...policy }
  }

  subscribe(listener: (state: PresenceState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}

export const presenceService = new PresenceService()
