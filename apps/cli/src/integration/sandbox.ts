export * as TrayambakSandbox from "./sandbox"

export interface SandboxConfig {
  readonly enabled: boolean
  readonly network: boolean
  readonly filesystem: boolean
  readonly mutation: boolean
}

export interface SandboxContext {
  readonly config: SandboxConfig
  readonly assert: (operation: string) => void
  readonly allow: (operation: string) => boolean
}

export class SandboxService implements SandboxContext {
  private configValue: SandboxConfig = {
    enabled: true,
    network: true,
    filesystem: true,
    mutation: true,
  }

  get config(): SandboxConfig {
    return this.configValue
  }

  getConfig(): SandboxConfig {
    return this.configValue
  }

  setConfig(config: Partial<SandboxConfig>): void {
    this.configValue = { ...this.configValue, ...config }
  }

  assert(operation: string): void {
    if (!this.configValue.enabled) return
    if (!this.allow(operation)) {
      throw new Error(`Sandbox blocked: ${operation}`)
    }
  }

  allow(operation: string): boolean {
    if (!this.configValue.enabled) return true
    switch (operation) {
      case "network":
        return this.configValue.network
      case "filesystem":
        return this.configValue.filesystem
      case "mutation":
        return this.configValue.mutation
      default:
        return true
    }
  }
}

export const sandboxService = new SandboxService()
