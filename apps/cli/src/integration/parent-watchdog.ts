export * as NemoParentWatchdog from "./parent-watchdog"

export interface WatchdogConfig {
  readonly checkInterval: number
  readonly maxRestarts: number
  readonly restartDelay: number
}

export interface WatchdogState {
  readonly parentPid: number
  readonly alive: boolean
  readonly restartCount: number
  readonly lastCheck: Date
}

export class ParentWatchdogService {
  private config: WatchdogConfig = {
    checkInterval: 5000,
    maxRestarts: 3,
    restartDelay: 1000,
  }
  private state?: WatchdogState
  private intervalId?: NodeJS.Timeout

  start(parentPid: number): void {
    // Re-arming must clear any live interval first: overwriting
    // `intervalId` leaked the previous timer, which stop() could never
    // reach (it only knows the last id) — the orphan kept calling check()
    // forever.
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
    this.state = {
      parentPid,
      alive: true,
      restartCount: 0,
      lastCheck: new Date(),
    }

    this.intervalId = setInterval(() => {
      this.check()
    }, this.config.checkInterval)
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }
  }

  getState(): WatchdogState | undefined {
    return this.state
  }

  private check(): void {
    if (!this.state) return

    try {
      process.kill(this.state.parentPid, 0)
      this.state = {
        ...this.state,
        alive: true,
        lastCheck: new Date(),
      }
    } catch {
      this.state = {
        ...this.state,
        alive: false,
        restartCount: this.state.restartCount + 1,
        lastCheck: new Date(),
      }
    }
  }

  setConfig(config: Partial<WatchdogConfig>): void {
    this.config = { ...this.config, ...config }
  }
}

export const parentWatchdogService = new ParentWatchdogService()
