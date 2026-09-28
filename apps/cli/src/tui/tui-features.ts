export * as TrayambakTuiFeatures from "./tui-features"

export interface TuiGoalSync {
  readonly goalId: string
  readonly description: string
  readonly progress: number
  readonly status: "active" | "complete" | "blocked" | "paused"
}

export interface TuiMemoryState {
  readonly enabled: boolean
  readonly count: number
  readonly lastUpdated?: Date
}

export interface TuiTerminalActivity {
  readonly active: boolean
  readonly lastActivity: Date
  readonly pendingEvents: number
}

export interface TuiCostAlert {
  readonly enabled: boolean
  readonly threshold: number
  readonly currentCost: number
  readonly currency: string
}

export class TuiFeatures {
  private goalSync: TuiGoalSync | null = null
  private memoryState: TuiMemoryState = { enabled: false, count: 0 }
  private terminalActivity: TuiTerminalActivity = {
    active: true,
    lastActivity: new Date(),
    pendingEvents: 0,
  }
  private costAlert: TuiCostAlert = {
    enabled: true,
    threshold: 10,
    currentCost: 0,
    currency: "USD",
  }

  setGoalSync(goal: TuiGoalSync): void {
    this.goalSync = goal
  }

  getGoalSync(): TuiGoalSync | null {
    return this.goalSync
  }

  setMemoryState(state: Partial<TuiMemoryState>): void {
    this.memoryState = { ...this.memoryState, ...state }
  }

  getMemoryState(): TuiMemoryState {
    return this.memoryState
  }

  setTerminalActivity(activity: Partial<TuiTerminalActivity>): void {
    this.terminalActivity = { ...this.terminalActivity, ...activity }
  }

  getTerminalActivity(): TuiTerminalActivity {
    return this.terminalActivity
  }

  setCostAlert(alert: Partial<TuiCostAlert>): void {
    this.costAlert = { ...this.costAlert, ...alert }
  }

  getCostAlert(): TuiCostAlert {
    return this.costAlert
  }

  checkCostThreshold(): boolean {
    return this.costAlert.currentCost >= this.costAlert.threshold
  }
}

export const tuiFeatures = new TuiFeatures()
