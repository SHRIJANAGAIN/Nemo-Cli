import { loadConfig, type NemoConfig } from "../../../runtime/src/index.js"
import {
  authFilePath,
  authorizeMcpServer,
  getMcpAuthStatus,
  removeMcpAuth,
  type McpOAuthConfig,
} from "../../../../packages/mcp/src/oauth.js"

export * as NemoMcpCommand from "./mcp"

export interface McpServer {
  readonly id: string
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
  readonly status: "active" | "inactive" | "error"
}

export class McpService {
  private servers: Map<string, McpServer> = new Map()

  register(server: McpServer): void {
    this.servers.set(server.id, server)
  }

  get(id: string): McpServer | undefined {
    return this.servers.get(id)
  }

  list(): McpServer[] {
    return Array.from(this.servers.values())
  }

  remove(id: string): boolean {
    return this.servers.delete(id)
  }

  setStatus(id: string, status: McpServer["status"]): boolean {
    const server = this.servers.get(id)
    if (!server) return false

    this.servers.set(id, { ...server, status })
    return true
  }
}

export const mcpService = new McpService()

export function mcpCommand(options: {
  action: string
  id?: string
  name?: string
  command?: string
  args?: string[]
}): string {
  switch (options.action) {
    case "list": {
      const servers = mcpService.list()
      return servers.map((s) => `${s.id}: ${s.name} [${s.status}]`).join("\n") || "No MCP servers"
    }
    case "add": {
      if (!options.id || !options.name || !options.command) return "Missing id, name, or command"
      mcpService.register({
        id: options.id,
        name: options.name,
        command: options.command,
        args: options.args ?? [],
        env: {},
        status: "inactive",
      })
      return `Added MCP server ${options.id}`
    }
    case "remove": {
      if (!options.id) return "Missing id"
      const removed = mcpService.remove(options.id)
      return removed ? `Removed MCP server ${options.id}` : `MCP server ${options.id} not found`
    }
    case "start": {
      if (!options.id) return "Missing id"
      const started = mcpService.setStatus(options.id, "active")
      return started ? `Started MCP server ${options.id}` : `MCP server ${options.id} not found`
    }
    case "stop": {
      if (!options.id) return "Missing id"
      const stopped = mcpService.setStatus(options.id, "inactive")
      return stopped ? `Stopped MCP server ${options.id}` : `MCP server ${options.id} not found`
    }
    default:
      return `Unknown MCP action: ${options.action}`
  }
}

const MCP_CLI_USAGE = "Usage: nemo mcp <list|auth|logout|status> [server]"

type RemoteSpecResolution = { ok: true; url: string; oauth: McpOAuthConfig } | { ok: false; error: string }

function remoteSpecFor(cfg: NemoConfig, name: string | undefined): RemoteSpecResolution {
  if (!name) return { ok: false, error: `Missing server name.\n${MCP_CLI_USAGE}` }
  const spec = cfg.mcpServers?.[name]
  if (!spec) {
    const known = Object.keys(cfg.mcpServers ?? {})
    return {
      ok: false,
      error: `MCP server '${name}' not found in config.${known.length > 0 ? ` Known: ${known.join(", ")}` : ""}`,
    }
  }
  if (!spec.url) return { ok: false, error: `'${name}' is a stdio server and needs no OAuth authorization.` }
  if (spec.oauth === false) return { ok: false, error: `OAuth is disabled for '${name}' (oauth: false).` }
  return { ok: true, url: spec.url, oauth: typeof spec.oauth === "object" ? spec.oauth : {} }
}

/**
 * `nemo mcp ...` - Shrijan-parity MCP management:
 *   list    configured servers + transport + auth status
 *   auth    run the OAuth 2.0 + PKCE flow for a remote server
 *   logout  delete stored tokens for a server
 *   status  auth status for a server
 */
export async function runMcpCli(args: string[]): Promise<void> {
  const action = args[0] ?? "list"
  const name = args[1]
  const cfg = loadConfig()

  switch (action) {
    case "list": {
      const servers = Object.entries(cfg.mcpServers ?? {})
      if (servers.length === 0) {
        process.stdout.write("No MCP servers configured (config `mcpServers` or NEMO_MCP_SERVERS).\n")
        return
      }
      for (const [serverName, spec] of servers) {
        const transport = spec.url ? "http" : "stdio"
        const auth = spec.url && spec.oauth !== false ? getMcpAuthStatus(serverName, spec.url) : "-"
        process.stdout.write(`${serverName}  [${transport}]  auth: ${auth}\n`)
      }
      return
    }
    case "auth": {
      if (!name) {
        process.stderr.write(`Missing server name.\n${MCP_CLI_USAGE}\n`)
        process.exitCode = 2
        return
      }
      const resolved = remoteSpecFor(cfg, name)
      if (!resolved.ok) {
        process.stderr.write(resolved.error + "\n")
        process.exitCode = 1
        return
      }
      process.stdout.write(`Authorizing MCP server '${name}'...\n`)
      try {
        await authorizeMcpServer(name, resolved.url, resolved.oauth)
        process.stdout.write(`Authorized '${name}'. Token stored in ${authFilePath()}\n`)
      } catch (err) {
        process.stderr.write(`Authorization failed: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exitCode = 1
      }
      return
    }
    case "logout": {
      if (!name) {
        process.stderr.write(`Missing server name.\n${MCP_CLI_USAGE}\n`)
        process.exitCode = 2
        return
      }
      const removed = removeMcpAuth(name)
      process.stdout.write(
        removed ? `Removed stored credentials for '${name}'.\n` : `No stored credentials for '${name}'.\n`,
      )
      return
    }
    case "status": {
      if (!name) {
        process.stderr.write(`Missing server name.\n${MCP_CLI_USAGE}\n`)
        process.exitCode = 2
        return
      }
      const spec = cfg.mcpServers?.[name]
      const status = getMcpAuthStatus(name, spec?.url)
      process.stdout.write(`${name}: ${status}\n`)
      if (status === "not_authenticated" && spec?.url && spec.oauth !== false) {
        process.stdout.write(`Run: nemo mcp auth ${name}\n`)
      }
      return
    }
    default:
      process.stderr.write(`Unknown mcp action: ${action}\n${MCP_CLI_USAGE}\n`)
      process.exitCode = 2
  }
}
