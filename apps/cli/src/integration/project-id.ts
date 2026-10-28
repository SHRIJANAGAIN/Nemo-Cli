export * as NemoProjectId from "./project-id"

import { existsSync } from "fs"
import { join } from "path"

export interface ProjectInfo {
  readonly id: string
  readonly name: string
  readonly root: string
  readonly type?: string
  readonly language?: string
}

export class ProjectIdService {
  private project?: ProjectInfo

  detect(root: string): ProjectInfo {
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? "unknown"
    const type = this.detectType(root)
    const language = this.detectLanguage(root)

    this.project = {
      id: `project-${Date.now()}`,
      name,
      root,
      type,
      language,
    }

    return this.project
  }

  getProject(): ProjectInfo | undefined {
    return this.project
  }

  update(updates: Partial<ProjectInfo>): void {
    if (!this.project) return
    this.project = { ...this.project, ...updates }
  }

  private detectType(root: string): string | undefined {
    if (this.hasFile(root, "package.json")) return "node"
    if (this.hasFile(root, "tsconfig.json")) return "typescript"
    if (this.hasFile(root, "Cargo.toml")) return "rust"
    if (this.hasFile(root, "go.mod")) return "go"
    if (this.hasFile(root, "pyproject.toml")) return "python"
    if (this.hasFile(root, "pom.xml")) return "java"
    if (this.hasFile(root, "build.gradle")) return "gradle"
    return undefined
  }

  private detectLanguage(root: string): string | undefined {
    const type = this.detectType(root)
    const languageMap: Record<string, string> = {
      node: "javascript",
      typescript: "typescript",
      rust: "rust",
      go: "go",
      python: "python",
      java: "java",
      gradle: "java",
    }
    return languageMap[type ?? ""]
  }

  private hasFile(root: string, file: string): boolean {
    return existsSync(join(root, file))
  }
}

export const projectIdService = new ProjectIdService()
