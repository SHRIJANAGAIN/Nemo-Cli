export * as TrayambakTaskResume from "./task-resume"

export interface TaskState {
  readonly taskId: string
  readonly status: "pending" | "running" | "completed" | "failed" | "interrupted"
  readonly startedAt: Date
  readonly completedAt?: Date
  readonly result?: unknown
  readonly error?: string
  readonly context: Record<string, unknown>
}

export class TaskResumeService {
  private tasks: Map<string, TaskState> = new Map()

  create(taskId: string, context: Record<string, unknown> = {}): TaskState {
    const task: TaskState = {
      taskId,
      status: "pending",
      startedAt: new Date(),
      context,
    }
    this.tasks.set(taskId, task)
    return task
  }

  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId)
  }

  start(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    this.tasks.set(taskId, { ...task, status: "running" })
    return true
  }

  complete(taskId: string, result: unknown): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    this.tasks.set(taskId, {
      ...task,
      status: "completed",
      completedAt: new Date(),
      result,
    })
    return true
  }

  fail(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    this.tasks.set(taskId, {
      ...task,
      status: "failed",
      completedAt: new Date(),
      error,
    })
    return true
  }

  interrupt(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    this.tasks.set(taskId, {
      ...task,
      status: "interrupted",
      completedAt: new Date(),
    })
    return true
  }

  canResume(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    return task?.status === "interrupted" || task?.status === "failed"
  }

  resume(taskId: string): TaskState | undefined {
    const task = this.tasks.get(taskId)
    if (!task || !this.canResume(taskId)) return undefined

    this.tasks.set(taskId, {
      ...task,
      status: "running",
      completedAt: undefined,
      error: undefined,
    })
    return this.tasks.get(taskId)
  }
}

export const taskResumeService = new TaskResumeService()
