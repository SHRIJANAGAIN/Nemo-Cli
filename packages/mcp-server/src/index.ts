/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

/**
 * MCP server over stdio (JSON-RPC 2.0): exposes Trayambak tools to MCP clients.
 * Methods: initialize, tools/list, tools/call, resources/list, prompts/list.
 * Run: `trayambak mcp-server`
 */

import * as readline from "readline"
import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { loadConfig, type TrayambakConfig } from "../../../apps/runtime/src/config.js"
import { approvalFor } from "../../../packages/core/src/approval.js"
import { getSafeEnv } from "../../../packages/core/src/env_filter.js"
import {
  runPreToolUseHooks,
  runPostToolUseHooks,
  type HookShellExecutor,
} from "../../../apps/runtime/src/tools/hook-exec.js"
import { evaluatePolicy, ExecDecision } from "../../../packages/execpolicy/src/policy.js"
import { isPathInside } from "../../sandbox/src/index.js"
import { DEFAULT_PERMISSIONS, type PermissionConfig } from "../../../packages/protocol/src/permissions.js"
// Single-sourced from the root package.json via sync-version — the
// advertised serverInfo version went stale (0.6.0 vs a 0.6.7 release).
import { VERSION } from "../../../apps/cli/src/version.js"

export interface McpToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: McpToolDef[] = [
  {
    name: "bash",
    description: "Execute a shell command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", description: "Timeout in milliseconds (1000-300000, default 10000)" },
      },
    },
  },
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "write_file",
    description: "Write a file (not executed via MCP — refused, use the CLI tools instead)",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
  },
  {
    name: "grep",
    description: "Search file contents (not executed via MCP — refused, use the CLI tools instead)",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
  },
  {
    name: "glob",
    description: "Find files by glob (not executed via MCP — refused, use the CLI tools instead)",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
  },
]

function send(id: unknown, result: unknown): void {
  if (id === undefined) return
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function sendError(id: unknown, code: number, message: string): void {
  if (id === undefined) return
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")
}

/** Test seam + server wiring knobs. Tests ALWAYS pass `config` (the default
 *  path reads the real machine config — never touch it from a suite) and a
 *  `policyDecide` stub wherever the exec-policy layer must be deterministic
 *  (the default reads the process-wide singleton, which is CWD-sensitive). */
export interface McpServerDeps {
  config?: TrayambakConfig
  hookExecutor?: HookShellExecutor
  policyDecide?: (command: string) => ExecDecision
}

/** Clamp the wire `timeoutMs` into [1s, 5min]; garbage/missing → 10s default. */
export function clampMcpTimeout(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return 10_000
  return Math.min(Math.max(n, 1000), 300_000)
}

/** Resolve `p` under `cwd` through symlinks/junctions and return null when
 *  it escapes the root. Mirrors the sandbox root check, plus realpath so a
 *  junction pointing at C:\Windows cannot launder an outside path (#36). */
export function resolveInsideRoot(cwd: string, p: string): string | null {
  const abs = path.resolve(cwd, p)
  let realRoot = cwd
  try {
    realRoot = fs.realpathSync(cwd)
  } catch {
    /* missing root: fall through to the lexical check */
  }
  let real = abs
  try {
    real = fs.realpathSync(abs)
  } catch {
    /* missing file: lexical check still applies; readFileSync errors next */
  }
  return isPathInside(real, realRoot) ? real : null
}

type GateVerdict = { ok: true } | { ok: false; reason: string }

/**
 * The tool gate, in agent-loop order: PreToolUse hooks → approvalFor →
 * (execpolicy for commands, roots for reads, at the call sites) — with one
 * headless difference: there is no interactive approver over stdio, so an
 * `ask` verdict refuses instead of prompting. Deny-lists, explicit allows,
 * and full-access behave exactly like the loop.
 */
async function gateTool(
  deps: McpServerDeps,
  config: TrayambakConfig,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<GateVerdict> {
  const hookInput = { toolName, args, cwd }
  try {
    const verdict = await runPreToolUseHooks(config, hookInput, deps.hookExecutor)
    if (verdict.decision === "deny" || verdict.stop) {
      return { ok: false, reason: `Hook blocked ${toolName}: ${verdict.reason ?? verdict.stopReason ?? "denied"}` }
    }
  } catch {
    /* hook infra failures never break the call — same as the loop */
  }
  const effectivePermissions = (config.permissions ?? DEFAULT_PERMISSIONS) as PermissionConfig
  const outcome = approvalFor(toolName, args, { uiMode: effectivePermissions.uiMode, config: effectivePermissions })
  if (outcome.decision === "deny") {
    return { ok: false, reason: `Trayambak permission denied for ${toolName}. Tool execution blocked.` }
  }
  if (outcome.decision === "ask") {
    return { ok: false, reason: `${toolName} requires approval (no interactive approver over MCP)` }
  }
  return { ok: true }
}

/** Run PostToolUse hooks (observe-only, never blocks) and fold their
 *  context into the result, mirroring the loop. */
async function postHookContext(
  deps: McpServerDeps,
  config: TrayambakConfig,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<string[]> {
  try {
    const extra = await runPostToolUseHooks(config, { toolName, args, cwd }, deps.hookExecutor)
    return extra.filter((s) => s.trim().length > 0)
  } catch {
    return []
  }
}

/** Real local execution for read-only tools. bash is bounded (10s default,
 *  32KB cap). Every call passes the tool gate first (see gateTool). */
async function executeLocalTool(
  deps: McpServerDeps,
  config: TrayambakConfig,
  cwd: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === "read_file") {
    const p = String(args.path ?? "")
    if (!p) throw new Error("missing 'path'")
    const gate = await gateTool(deps, config, name, { path: p }, cwd)
    if (!gate.ok) throw new Error(gate.reason)
    const abs = resolveInsideRoot(cwd, p)
    if (!abs) throw new Error(`read refused: ${p} is outside the allowed root (${cwd})`)
    const text = fs.readFileSync(abs, "utf8").slice(0, 32_000)
    const extra = await postHookContext(deps, config, name, { path: p }, cwd)
    return extra.length > 0 ? `${text}\n${extra.join("\n")}` : text
  }
  if (name === "bash") {
    const cmd = String(args.command ?? "")
    if (!cmd) throw new Error("missing 'command'")
    const gate = await gateTool(deps, config, name, { command: cmd }, cwd)
    if (!gate.ok) throw new Error(gate.reason)
    const decide = deps.policyDecide ?? evaluatePolicy
    const policy = decide(cmd)
    if (policy === ExecDecision.Deny) throw new Error(`exec policy denies: ${cmd}`)
    if (policy === ExecDecision.Ask)
      throw new Error(`exec policy requires approval for: ${cmd} (no interactive approver over MCP)`)
    const timeoutMs = clampMcpTimeout(args.timeoutMs)
    const out = execFileSync(cmd, {
      cwd,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      timeout: timeoutMs,
      maxBuffer: 32_768,
      windowsHide: true,
      // Filtered env, like every other child spawn in the repo (hook-exec,
      // mcp-runner): omitting `env` handed the FULL process environment —
      // provider API keys included — to any command the gate allows (#63).
      env: getSafeEnv(process.env),
    } as never)
    const text = String(out).slice(0, 32_000)
    const extra = await postHookContext(deps, config, name, { command: cmd }, cwd)
    return extra.length > 0 ? `${text}\n${extra.join("\n")}` : text
  }
  if (name === "grep" || name === "glob" || name === "write_file") {
    throw new Error(`${name} is not executed by mcp-server (use the CLI tools instead)`)
  }
  throw new Error(`unknown tool: ${name}`)
}

export async function dispatchMcpServer(
  req: {
    id?: unknown
    method: string
    params?: Record<string, unknown>
  },
  deps: McpServerDeps = {},
): Promise<void> {
  switch (req.method) {
    case "initialize":
      send(req.id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "trayambak", version: VERSION }, // stamped from root package.json by sync-version
        capabilities: { tools: {} },
      })
      break
    case "tools/list":
      send(req.id, { tools: TOOLS })
      break
    case "tools/call": {
      const name = (req.params ?? {}).name as string
      const args = ((req.params ?? {}).arguments ?? {}) as Record<string, unknown>
      const found = TOOLS.find((t) => t.name === name)
      if (!found) sendError(req.id, -32602, `unknown tool: ${name}`)
      else {
        // Config resolves here (not at dispatch): list/resources/prompts
        // stay config-free and hermetic; only execution loads it.
        const config = deps.config ?? loadConfig()
        try {
          const text = await executeLocalTool(deps, config, config.cwd, name, args)
          send(req.id, { content: [{ type: "text", text }] })
        } catch (err) {
          send(req.id, {
            content: [{ type: "text", text: `error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          })
        }
      }
      break
    }
    case "resources/list":
      send(req.id, { resources: [] })
      break
    case "prompts/list":
      send(req.id, { prompts: [] })
      break
    default:
      sendError(req.id, -32601, `unknown method: ${req.method}`)
  }
}

/** Ref'd keep-alive tick: effectively infinite, well under Node's 2^31-1 ms timer cap. */
const MCP_KEEP_ALIVE_TICK_MS = 1 << 30
/** How long the MCP server outlives stdin EOF; see runMcpServer. */
const MCP_EXIT_GRACE_MS = 500

export function runMcpServer(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  // Same stdio contract as the ACP server (packages/acp/src/index.ts):
  // serve until stdin closes, and pin the event loop for the whole
  // session — an idle loop that drains while the client still holds the
  // pipe lets the MCP server exit mid-session, and the client's cleanup
  // then signals a dead pid (ProcessLookupError).
  const keepAlive = setInterval(() => {}, MCP_KEEP_ALIVE_TICK_MS)
  // stdin EOF: release the pin, but hold the pid for one beat so a
  // close-then-terminate client lands its signal on a live process.
  let pinReleased = false
  const releasePin = (): void => {
    if (pinReleased) return
    pinReleased = true
    clearInterval(keepAlive)
    setTimeout(() => {}, MCP_EXIT_GRACE_MS)
  }
  // Readline emits "close" on input *EOF* only — a destroyed or errored
  // pipe emits the input's own "close" without ever feeding readline an
  // 'end', which would leave the pin held forever (zombie server). Both
  // paths release, exactly once.
  rl.on("close", releasePin)
  process.stdin.on("close", releasePin)
  if (process.stdin.readableEnded) rl.close()
  rl.on("line", (line) => {
    if (!line.trim()) return
    try {
      const req = JSON.parse(line) as { id?: unknown; method: string; params?: Record<string, unknown> }
      dispatchMcpServer(req).catch((err) => sendError(req.id, -32000, String(err)))
    } catch {
      /* malformed */
    }
  })
}
