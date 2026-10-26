export * as NemoGitRefs from "./git-refs"

export interface GitRef {
  readonly name: string
  readonly type: "branch" | "tag" | "remote"
  readonly commit: string
  readonly message?: string
}

export interface GitStatus {
  readonly branch: string
  readonly ahead: number
  readonly behind: number
  readonly dirty: boolean
  readonly staged: number
  readonly modified: number
  readonly added: number
  readonly deleted: number
}

export class GitRefsService {
  private refs: Map<string, GitRef> = new Map()
  private status?: GitStatus

  setRefs(refs: GitRef[]): void {
    this.refs.clear()
    for (const ref of refs) {
      this.refs.set(ref.name, ref)
    }
  }

  getRef(name: string): GitRef | undefined {
    return this.refs.get(name)
  }

  listRefs(): GitRef[] {
    return Array.from(this.refs.values())
  }

  setStatus(status: GitStatus): void {
    this.status = status
  }

  getStatus(): GitStatus | undefined {
    return this.status
  }

  getCurrentBranch(): string | undefined {
    return this.status?.branch
  }

  isDirty(): boolean {
    return this.status?.dirty ?? false
  }
}

export const gitRefsService = new GitRefsService()
