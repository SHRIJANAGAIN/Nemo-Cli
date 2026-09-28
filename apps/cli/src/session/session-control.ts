export * as TrayambakSessionControl from "./session-control"

export type SessionControlStatus = "running" | "paused" | "stopped" | "error"

export interface SessionControl {
  readonly sessionId: string
  readonly status: SessionControlStatus
  readonly canPause: boolean
  readonly canResume: boolean
  readonly canStop: boolean
}

export class SessionControlService {
  private controls: Map<string, SessionControl> = new Map()

  create(sessionId: string): SessionControl {
    const control: SessionControl = {
      sessionId,
      status: "running",
      canPause: true,
      canResume: false,
      canStop: true,
    }
    this.controls.set(sessionId, control)
    return control
  }

  get(sessionId: string): SessionControl | undefined {
    return this.controls.get(sessionId)
  }

  pause(sessionId: string): boolean {
    const control = this.controls.get(sessionId)
    if (!control || !control.canPause) return false

    this.controls.set(sessionId, {
      ...control,
      status: "paused",
      canPause: false,
      canResume: true,
    })
    return true
  }

  resume(sessionId: string): boolean {
    const control = this.controls.get(sessionId)
    if (!control || !control.canResume) return false

    this.controls.set(sessionId, {
      ...control,
      status: "running",
      canPause: true,
      canResume: false,
    })
    return true
  }

  stop(sessionId: string): boolean {
    const control = this.controls.get(sessionId)
    if (!control || !control.canStop) return false

    this.controls.set(sessionId, {
      ...control,
      status: "stopped",
      canPause: false,
      canResume: false,
      canStop: false,
    })
    return true
  }

  error(sessionId: string): boolean {
    const control = this.controls.get(sessionId)
    if (!control) return false

    this.controls.set(sessionId, {
      ...control,
      status: "error",
      canPause: false,
      canResume: false,
      canStop: true,
    })
    return true
  }
}

export const sessionControlService = new SessionControlService()
