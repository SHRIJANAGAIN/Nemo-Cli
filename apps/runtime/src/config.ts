/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { McpOAuthConfig } from "../../../packages/mcp/src/oauth.js"
import { parseTokenBudget } from "../../../packages/core/src/token_budget.js"

export interface TrayambakConfig {
  baseUrl: string
  model: string
  /** Cheap model for background chores (auto-titles). Falls back to `model` when unset. */
  small_model?: string
  /** Default model for subagent children. Falls back to the parent run's model when unset. */
  subagent_model?: string
  apiKey: string
  cwd: string
  temperature: number
  topP: number
  maxTokens: number
  /** Model context window in tokens — drives proactive compaction. */
  contextWindow?: number
  timeoutMs: number
  /** Shell command used by the bash tool, e.g. "bash -c" or "cmd /c". */
  shellCommand: string
  /** Maximum lines retained from a tool's output before truncation. */
  maxOutputLines: number
  /** Maximum bytes retained from a tool's output before truncation. */
  maxOutputBytes: number
  /** Hard cap on agent turns per prompt to avoid runaway loops. */
  maxTurns: number
  /** Hard cap on tool calls per prompt (anti-runaway / anti-hallucination). */
  maxToolCalls: number
  /** Session budget spec: token cap ("50k", "1.5M", "50000 tokens") or turn
   *  cap ("40 turns"); "-1" disables. Applied by runAgentLoop on entry.
   *  Invalid specs fall back to no budget WITH a warning (never throw). */
  budget?: string
  /** Max distinct tool names allowed per session across the whole run. */
  maxDistinctToolCalls: number
  /** Max tool calls allowed per second (rate limit). */
  toolCallRate: number
  /** Number of transient provider failures to retry before surfacing an error. */
  maxRetries: number
  /** Delay between transient provider retries. */
  retryDelayMs: number
  /** Maximum number of independent tool calls executed concurrently. */
  maxParallelToolCalls: number
  /** Enable llama.cpp native function calling; disable to use text fallback. */
  nativeTools: boolean
  /** Context size for llama.cpp server (default 16384). */
  ctxSize?: number
  /** Batch size for llama.cpp server (default 256). */
  batchSize?: number
  /** Micro-batch size for llama.cpp server (default 128). */
  ubatchSize?: number
  /** Path to a local GGUF model used when launching a bundled llama.cpp server. */
  modelPath?: string
  /** Explicit path to a prebuilt llama.cpp server binary (persisted in config). */
  llamaCppBin?: string
  /** Reasoning effort level for the model. Maps to provider-specific tokens:
   *  low=10, medium=20, high=40, xhigh=120, max=unlimited. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max"
  /** Scratchpad directory for temporary files (defaults to cwd/.scratchpad). */
  scratchpadDir?: string
  /** Model provider backend: "llamacpp", "nvidia", "nvidia-nim", "openai",
   *  "xai", "huggingface", "anthropic", "google", "ollama", "custom",
   *  plus OpenAI-compatible gateways: "groq", "mistral", "cerebras",
   *  "together", "deepinfra", "cohere", "perplexity", "openrouter",
   *  "fireworks", "venice", "azure", "skt-gateway"
   *  (bring-your-own OpenAI-compatible endpoint). */
  provider?:
    | "llamacpp"
    | "nvidia"
    | "nvidia-nim"
    | "openai"
    | "xai"
    | "huggingface"
    | "anthropic"
    | "google"
    | "ollama"
    | "custom"
    | "groq"
    | "mistral"
    | "cerebras"
    | "together"
    | "deepinfra"
    | "cohere"
    | "perplexity"
    | "openrouter"
    | "fireworks"
    | "venice"
    | "azure"
    | "skt-gateway"
  /** MCP (Model Context Protocol) servers. Each maps a server name to a stdio
   *  (`command` + `args`) or HTTP (`url`) transport spec. Exposed as mcp__ tools.
   *  HTTP servers support `headers`, and OAuth 2.0 + PKCE via `oauth`
   *  (`false` disables; object tunes clientId/clientSecret/scope/callbackPort/redirectUri). */
  mcpServers?: Record<
    string,
    {
      command?: string[]
      url?: string
      env?: Record<string, string>
      timeoutMs?: number
      cwd?: string
      headers?: Record<string, string>
      oauth?: boolean | McpOAuthConfig
    }
  >
  /** Directory that holds Skill files (`*.md` with YAML front-matter). Exposed as skill__ tools. */
  skillsDir?: string
  /** Additional local directories containing agent profile definitions. */
  agentProfileDirs?: string[]
  /** Developer mode configuration */
  developerMode?: Partial<import("./developer-mode").DeveloperModeConfig>
  /** Permission rules and default behavior for risky tool calls. */
  permissions?: Partial<import("../../../packages/protocol/src/permissions").PermissionConfig>
  /** Hook called when a tool needs runtime approval before execution. */
  onRequestPermission?: (tool: string, args: unknown, reason: string) => Promise<boolean>
  /** Toolset bundles for composing available tools. */
  toolsets?: {
    defaults: string[]
    disabled: string[]
    platform?: Record<string, string[]>
  }
  /** External provider configurations. */
  providers?: Array<{
    id: string
    type: string
    label: string
    baseUrl: string
    apiKey?: string
    model?: string
    temperature?: number
    topP?: number
    maxTokens?: number
    contextWindow?: number
    timeoutMs?: number
    reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max"
  }>
  /** Active provider id. */
  activeProviderId?: string
  /** Per-mode provider/model override (e.g. { debug: { provider: "openai", model: "gpt-4o" } }). */
  modeApiConfigs?: Record<string, { provider?: string; model?: string }>
  /** Model ids marked as favorites in the TUI model picker. */
  modelFavorites?: string[]
  /** Recently used model ids, most recent first (TUI model picker "Recent"). */
  modelRecents?: string[]
  /** Command hooks fired around tool calls (PreToolUse can block/ask,
   *  PostToolUse appends context). Matcher groups select tool names. */
  hooks?: {
    preToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string; timeoutSec?: number }> }>
    postToolUse?: Array<{ matcher?: string; hooks: Array<{ command: string; timeoutSec?: number }> }>
  }
  /** Last live model list per provider id ("saare models" cache): shown
   *  instead of the tiny static fallback when the endpoint is unreachable
   *  or the key is missing. Refreshed on every successful live fetch. */
  modelCache?: Record<string, string[]>
  /** Workspace checkpoints master switch (/checkpoint on|off). Default true.
   *  Off = no per-turn capture; undo/redo report the state instead. */
  checkpointsEnabled?: boolean
  /** Auto-extract keeper facts from turn text into persistent memory
   *  (EXTRACT_MEMORIES port: conservative no-LLM heuristic, max 2/turn,
   *  visible via /memory). Default true; set false to keep memory manual. */
  memoryAutoExtract?: boolean
  /** Active terminal theme name (e.g. "trayambak-dark", "claude-dark", "claude-light"). */
  themeName?: string
  /** Default option number for AskUserQuestion (1-indexed). Pressing Enter without typing selects this option. Changeable by typing a different number. */
  questionDefaultOption?: number
  /** AskUserQuestion answer mode: "both" (choose by number or type custom), "choose" (number only), "type" (text only). Default "both". */
  questionAnswerMode?: "both" | "choose" | "type"
  /** Custom monospace font family for code/terminal display (e.g. "Fira Code", "JetBrains Mono"). */
  codeFont?: string
  /** Enable browser automation (page navigation, link following, form interaction). */
  browserAutomationEnabled?: boolean
  /** Run browser automation in headless mode (no visible window). Default true. */
  browserAutomationHeadless?: boolean
  /** Maximum concurrent browser pages. Default 5. */
  browserAutomationMaxPages?: number
  /** Browser automation timeout in milliseconds. Default 30000. */
  browserAutomationTimeoutMs?: number
  /** Default browser viewport width for automation. Default 1280. */
  browserAutomationViewportWidth?: number
  /** Default browser viewport height for automation. Default 720. */
  browserAutomationViewportHeight?: number
  /** Whether to capture screenshots during browser automation. Default false. */
  browserAutomationCaptureScreenshot?: boolean
  /** MCP health check: enable periodic connection health monitoring. Default false. */
  mcpHealthCheckEnabled?: boolean
  /** Interval in milliseconds between MCP health checks. Default 30000. */
  mcpHealthCheckIntervalMs?: number
  /** MCP tool cache: cache listTools results. Default true. */
  mcpToolCacheEnabled?: boolean
  /** MCP tool cache TTL in milliseconds. Default 300000 (5 minutes). */
  mcpToolCacheTtlMs?: number
  /** MCP auto-reconnect: reconnect after transport failure. Default true. */
  mcpReconnectOnFailure?: boolean
  /** Auto-update policy (SKT AI LABS parity): true = apply patch updates, false = never check, "notify" = only notify about updates. Default true. */
  autoupdate?: boolean | "notify"
  /** License key for gated toolsets (TRAYAMBAK_LICENSE_KEY). Absent = pentest stripped. Never logged. */
  licenseKey?: string
  /** GitHub login from CLI OAuth (/github login). Display identity only — persisted so the system prompt can name the operator. Never a secret. */
  githubLogin?: string
  /** License server base URL (TRAYAMBAK_LICENSE_SERVER). Default https://skt.sktailabs.in. Self-host to run your own registry. */
  licenseServerUrl?: string
}

const DEFAULTS: TrayambakConfig = {
  baseUrl: "https://integrate.api.nvidia.com",
  model: "nvidia/nemotron-3-super-120b-a12b",
  small_model: undefined,
  subagent_model: undefined,
  apiKey: "",
  cwd: process.cwd(),
  temperature: 0,
  topP: 0.9,
  maxTokens: 8192,
  contextWindow: 128_000,
  timeoutMs: 600_000,
  shellCommand: detectDefaultShell(),
  maxOutputLines: 2000,
  maxOutputBytes: 256 * 1024,
  maxTurns: 64,
  maxToolCalls: 100,
  budget: undefined,
  maxDistinctToolCalls: 1000,
  toolCallRate: 2,
  maxRetries: 2,
  retryDelayMs: 750,
  maxParallelToolCalls: 4,
  nativeTools: true,
  ctxSize: 16384,
  batchSize: 256,
  ubatchSize: 128,
  modelPath: undefined,
  reasoningEffort: "medium",
  permissions: {
    mode: "default",
    rules: [
      { tool: "bash", pattern: "rm -rf /", allow: false },
      { tool: "bash", pattern: "rm -rf ~", allow: false },
      { tool: "bash", pattern: "rm -rf .", allow: false },
      { tool: "bash", pattern: "del /s /q", allow: false },
      { tool: "bash", pattern: "format", allow: false },
      { tool: "bash", pattern: "shutdown", allow: false },
      { tool: "bash", pattern: "reboot", allow: false },
      { tool: "bash", pattern: "sudo", allow: false },
      { tool: "bash", pattern: "su", allow: false },
      { tool: "write_file", pattern: "*", allow: false },
      { tool: "edit_file", pattern: "*", allow: false },
    ],
    askByDefault: true,
  },
  scratchpadDir: ".scratchpad",
  autoupdate: true,
  provider: "nvidia",
  themeName: undefined,
  questionDefaultOption: 1,
  questionAnswerMode: "both" as const,
  codeFont: undefined,
  browserAutomationEnabled: false,
  browserAutomationHeadless: true,
  browserAutomationMaxPages: 5,
  browserAutomationTimeoutMs: 30_000,
  browserAutomationViewportWidth: 1280,
  browserAutomationViewportHeight: 720,
  browserAutomationCaptureScreenshot: false,
  mcpHealthCheckEnabled: false,
  mcpHealthCheckIntervalMs: 30_000,
  mcpToolCacheEnabled: true,
  mcpToolCacheTtlMs: 300_000,
  mcpReconnectOnFailure: true,
  toolsets: {
    defaults: ["core", "agentic", "ops", "tasks", "mcp", "skills"],
    disabled: [],
    platform: {},
  },
}

function detectDefaultShell(): string {
  if (process.platform === "win32") {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe"
    if (fs.existsSync(gitBash)) return `"${gitBash}" -c`
    return "cmd /c"
  }
  return process.env.SHELL && process.env.SHELL.length > 0 ? `${process.env.SHELL} -c` : "bash -c"
}

function configDir(): string {
  const local = path.join(process.cwd(), ".trayambak")
  if (fs.existsSync(local)) return local
  return path.join(os.homedir(), ".trayambak")
}

export function configPath(): string {
  // Explicit override (TRAYAMBAK_CONFIG, set by `--config <file>`):
  // resolve against the current directory so callers get one exact file.
  const explicit = process.env.TRAYAMBAK_CONFIG
  if (explicit) return path.resolve(explicit)
  return path.join(configDir(), "config.json")
}

export function loadConfig(overrides: Partial<TrayambakConfig> = {}): TrayambakConfig {
  let fileConfig: Partial<TrayambakConfig> = {}
  const file = configPath()
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      // Legacy tolerance: an older CLI path persisted flag names verbatim
      // ("--apiKey", "--baseUrl", "--provider", "--model"). Map them onto the
      // canonical keys when the canonical key is absent — observed live in
      // CWD .trayambak/config.json, where the stray keys hid the real config
      // and forced provider/apiKey back to defaults (401s).
      for (const [flag, key] of [
        ["--apiKey", "apiKey"],
        ["--baseUrl", "baseUrl"],
        ["--provider", "provider"],
        ["--model", "model"],
      ] as const) {
        if (raw[key] === undefined && raw[flag] !== undefined) raw[key] = raw[flag]
        delete raw[flag]
      }
      fileConfig = raw as Partial<TrayambakConfig>
    } catch {
      fileConfig = {}
    }
  }

  const envConfig: Partial<TrayambakConfig> = {}
  if (process.env.TRAYAMBAK_BASE_URL) envConfig.baseUrl = process.env.TRAYAMBAK_BASE_URL
  if (process.env.TRAYAMBAK_MODEL) envConfig.model = process.env.TRAYAMBAK_MODEL
  if (process.env.TRAYAMBAK_SMALL_MODEL) envConfig.small_model = process.env.TRAYAMBAK_SMALL_MODEL
  if (process.env.TRAYAMBAK_SUBAGENT_MODEL) envConfig.subagent_model = process.env.TRAYAMBAK_SUBAGENT_MODEL
  if (process.env.TRAYAMBAK_API_KEY) envConfig.apiKey = process.env.TRAYAMBAK_API_KEY
  if (process.env.TRAYAMBAK_CWD) envConfig.cwd = process.env.TRAYAMBAK_CWD
  if (process.env.TRAYAMBAK_TEMPERATURE) envConfig.temperature = Number(process.env.TRAYAMBAK_TEMPERATURE)
  if (process.env.TRAYAMBAK_TOP_P) envConfig.topP = Number(process.env.TRAYAMBAK_TOP_P)
  if (process.env.TRAYAMBAK_MAX_TOKENS) envConfig.maxTokens = Number(process.env.TRAYAMBAK_MAX_TOKENS)
  if (process.env.TRAYAMBAK_CONTEXT_WINDOW) envConfig.contextWindow = Number(process.env.TRAYAMBAK_CONTEXT_WINDOW)
  if (process.env.TRAYAMBAK_TIMEOUT_MS) envConfig.timeoutMs = Number(process.env.TRAYAMBAK_TIMEOUT_MS)
  if (process.env.TRAYAMBAK_SHELL_COMMAND) envConfig.shellCommand = process.env.TRAYAMBAK_SHELL_COMMAND
  if (process.env.TRAYAMBAK_MAX_OUTPUT_LINES) envConfig.maxOutputLines = Number(process.env.TRAYAMBAK_MAX_OUTPUT_LINES)
  if (process.env.TRAYAMBAK_MAX_OUTPUT_BYTES) envConfig.maxOutputBytes = Number(process.env.TRAYAMBAK_MAX_OUTPUT_BYTES)
  if (process.env.TRAYAMBAK_MAX_TURNS) envConfig.maxTurns = Number(process.env.TRAYAMBAK_MAX_TURNS)
  if (process.env.TRAYAMBAK_MAX_TOOL_CALLS) envConfig.maxToolCalls = Number(process.env.TRAYAMBAK_MAX_TOOL_CALLS)
  if (process.env.TRAYAMBAK_BUDGET) envConfig.budget = process.env.TRAYAMBAK_BUDGET
  if (process.env.TRAYAMBAK_MAX_DISTINCT_TOOL_CALLS)
    envConfig.maxDistinctToolCalls = Number(process.env.TRAYAMBAK_MAX_DISTINCT_TOOL_CALLS)
  if (process.env.TRAYAMBAK_TOOL_CALL_RATE) envConfig.toolCallRate = Number(process.env.TRAYAMBAK_TOOL_CALL_RATE)
  if (process.env.TRAYAMBAK_MAX_RETRIES) envConfig.maxRetries = Number(process.env.TRAYAMBAK_MAX_RETRIES)
  if (process.env.TRAYAMBAK_RETRY_DELAY_MS) envConfig.retryDelayMs = Number(process.env.TRAYAMBAK_RETRY_DELAY_MS)
  if (process.env.TRAYAMBAK_MAX_PARALLEL_TOOL_CALLS)
    envConfig.maxParallelToolCalls = Number(process.env.TRAYAMBAK_MAX_PARALLEL_TOOL_CALLS)
  if (process.env.TRAYAMBAK_NATIVE_TOOLS) envConfig.nativeTools = process.env.TRAYAMBAK_NATIVE_TOOLS === "true"
  if (process.env.TRAYAMBAK_SKILLS_DIR) envConfig.skillsDir = process.env.TRAYAMBAK_SKILLS_DIR
  if (process.env.TRAYAMBAK_AGENT_PROFILE_DIRS) {
    envConfig.agentProfileDirs = process.env.TRAYAMBAK_AGENT_PROFILE_DIRS.split(path.delimiter).filter(Boolean)
  }
  if (process.env.TRAYAMBAK_LLAMACPP_BIN) envConfig.llamaCppBin = process.env.TRAYAMBAK_LLAMACPP_BIN
  if (process.env.TRAYAMBAK_MCP_SERVERS) {
    try {
      envConfig.mcpServers = JSON.parse(process.env.TRAYAMBAK_MCP_SERVERS) as TrayambakConfig["mcpServers"]
    } catch {
      /* ignore malformed env */
    }
  }
  // Project scope: ./.trayambak/mcp.json merges under global config (project wins per-server).
  try {
    const projectMcp = path.join(process.cwd(), ".trayambak", "mcp.json")
    if (fs.existsSync(projectMcp)) {
      const parsed = JSON.parse(fs.readFileSync(projectMcp, "utf8")) as { mcpServers?: Record<string, unknown> }
      const proj = cleanMcpServers(parsed.mcpServers ?? parsed)
      if (proj) envConfig.mcpServers = { ...(envConfig.mcpServers ?? {}), ...proj }
    }
  } catch {
    /* project MCP is best-effort */
  }
  if (process.env.TRAYAMBAK_REASONING_EFFORT)
    envConfig.reasoningEffort = process.env.TRAYAMBAK_REASONING_EFFORT as TrayambakConfig["reasoningEffort"]
  if (process.env.TRAYAMBAK_SCRATCHPAD_DIR) envConfig.scratchpadDir = process.env.TRAYAMBAK_SCRATCHPAD_DIR
  if (process.env.TRAYAMBAK_PROVIDER) envConfig.provider = process.env.TRAYAMBAK_PROVIDER as TrayambakConfig["provider"]
  if (!envConfig.modelPath && process.env.TRAYAMBAK_MODEL_PATH) {
    envConfig.modelPath = process.env.TRAYAMBAK_MODEL_PATH
  }
  if (process.env.TRAYAMBAK_THEME) envConfig.themeName = process.env.TRAYAMBAK_THEME
  if (process.env.TRAYAMBAK_QUESTION_DEFAULT_OPTION)
    envConfig.questionDefaultOption = Number(process.env.TRAYAMBAK_QUESTION_DEFAULT_OPTION)
  if (process.env.TRAYAMBAK_QUESTION_ANSWER_MODE)
    envConfig.questionAnswerMode = process.env.TRAYAMBAK_QUESTION_ANSWER_MODE as "both" | "choose" | "type"
  if (process.env.TRAYAMBAK_CODE_FONT) envConfig.codeFont = process.env.TRAYAMBAK_CODE_FONT
  if (process.env.TRAYAMBAK_BROWSER_AUTOMATION_ENABLED)
    envConfig.browserAutomationEnabled = process.env.TRAYAMBAK_BROWSER_AUTOMATION_ENABLED === "true"
  if (process.env.TRAYAMBAK_BROWSER_AUTOMATION_HEADLESS)
    envConfig.browserAutomationHeadless = process.env.TRAYAMBAK_BROWSER_AUTOMATION_HEADLESS === "true"
  if (process.env.TRAYAMBAK_BROWSER_AUTOMATION_MAX_PAGES)
    envConfig.browserAutomationMaxPages = Number(process.env.TRAYAMBAK_BROWSER_AUTOMATION_MAX_PAGES)
  if (process.env.TRAYAMBAK_BROWSER_AUTOMATION_TIMEOUT_MS)
    envConfig.browserAutomationTimeoutMs = Number(process.env.TRAYAMBAK_BROWSER_AUTOMATION_TIMEOUT_MS)
  if (process.env.TRAYAMBAK_BROWSER_AUTOMATION_VIEWPORT_WIDTH)
    envConfig.browserAutomationViewportWidth = Number(process.env.TRAYAMBAK_BROWSER_AUTOMATION_VIEWPORT_WIDTH)
  if (process.env.TRAYAMBAK_BROWSER_AUTOMATION_VIEWPORT_HEIGHT)
    envConfig.browserAutomationViewportHeight = Number(process.env.TRAYAMBAK_BROWSER_AUTOMATION_VIEWPORT_HEIGHT)
  if (process.env.TRAYAMBAK_BROWSER_AUTOMATION_CAPTURE_SCREENSHOT)
    envConfig.browserAutomationCaptureScreenshot =
      process.env.TRAYAMBAK_BROWSER_AUTOMATION_CAPTURE_SCREENSHOT === "true"
  if (process.env.TRAYAMBAK_MCP_HEALTH_CHECK_ENABLED)
    envConfig.mcpHealthCheckEnabled = process.env.TRAYAMBAK_MCP_HEALTH_CHECK_ENABLED === "true"
  if (process.env.TRAYAMBAK_MCP_HEALTH_CHECK_INTERVAL_MS)
    envConfig.mcpHealthCheckIntervalMs = Number(process.env.TRAYAMBAK_MCP_HEALTH_CHECK_INTERVAL_MS)
  if (process.env.TRAYAMBAK_MCP_TOOL_CACHE_ENABLED)
    envConfig.mcpToolCacheEnabled = process.env.TRAYAMBAK_MCP_TOOL_CACHE_ENABLED === "true"
  if (process.env.TRAYAMBAK_MCP_TOOL_CACHE_TTL_MS)
    envConfig.mcpToolCacheTtlMs = Number(process.env.TRAYAMBAK_MCP_TOOL_CACHE_TTL_MS)
  if (process.env.TRAYAMBAK_MCP_RECONNECT_ON_FAILURE)
    envConfig.mcpReconnectOnFailure = process.env.TRAYAMBAK_MCP_RECONNECT_ON_FAILURE !== "false"
  if (process.env.TRAYAMBAK_AUTOUPDATE === "false" || process.env.TRAYAMBAK_AUTOUPDATE === "0")
    envConfig.autoupdate = false
  else if (process.env.TRAYAMBAK_AUTOUPDATE === "notify") envConfig.autoupdate = "notify"
  else if (process.env.TRAYAMBAK_AUTOUPDATE === "true" || process.env.TRAYAMBAK_AUTOUPDATE === "1")
    envConfig.autoupdate = true
  if (process.env.TRAYAMBAK_LICENSE_KEY) envConfig.licenseKey = process.env.TRAYAMBAK_LICENSE_KEY
  if (process.env.TRAYAMBAK_LICENSE_SERVER) envConfig.licenseServerUrl = process.env.TRAYAMBAK_LICENSE_SERVER

  const merged: TrayambakConfig = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...stripUndefined(overrides),
  }
  merged.cwd = path.resolve(merged.cwd)
  return sanitizeConfig(merged)
}

export function saveConfig(config: Partial<TrayambakConfig>): void {
  const dir = configDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = configPath()
  let existing: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
    } catch {
      // A torn concurrent write (or crash mid-write) leaves partial JSON.
      // The old code fell back to {} and then OVERWROTE the file with only
      // the new keys — wiping provider/model/theme/keys in one shot
      // (observed live: config reduced to bare permissions). Preserve the
      // corrupt bytes aside for forensics instead of compounding the loss.
      try {
        const backup = `${file}.corrupt-${Date.now()}`
        fs.copyFileSync(file, backup)
        debugConfigLog(`config corrupt, backed up to ${backup}`)
      } catch {
        /* best effort */
      }
      existing = {}
    }
  }
  // Atomic publish: readers see the old file or the new file, never a
  // half-written one (rename is atomic on the same volume). The previous
  // good file rotates to config.json.bak first, so an outright deletion
  // followed by a merge-save (observed live: config reduced to bare
  // permissions) is always recoverable with one copy-back.
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`)
    } catch {
      /* best effort */
    }
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify({ ...existing, ...config }, null, 2), { encoding: "utf8", mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    /* not all platforms support chmod */
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on Windows */
  }
}

function debugConfigLog(line: string): void {
  if (process.env.TRAYAMBAK_DEBUG_INPUT !== "1") return
  try {
    fs.appendFileSync("trayambak-config.log", `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* never break config writes for logging */
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Validate MCP server specs at load: bad entries used to sail through and
 *  crash later inside spawn/URL parsing. Invalid entries are dropped (a
 *  corrupt entry must never take down unrelated servers). */
export function cleanMcpServers(raw: unknown): TrayambakConfig["mcpServers"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: NonNullable<TrayambakConfig["mcpServers"]> = {}
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) continue
    const s = spec as Record<string, unknown>
    const hasCommand = Array.isArray(s.command) && s.command.length > 0 && s.command.every((c) => typeof c === "string")
    let url: string | undefined
    if (typeof s.url === "string" && s.url.trim().length > 0) {
      try {
        const parsed = new URL(s.url.trim())
        if (parsed.protocol === "http:" || parsed.protocol === "https:") url = s.url.trim()
      } catch {
        url = undefined
      }
    }
    // Exactly one transport, valid: stdio needs a non-empty argv, HTTP a real URL.
    if (url && hasCommand) continue
    if (!url && !hasCommand) continue
    const clean: NonNullable<TrayambakConfig["mcpServers"]>[string] = {}
    if (hasCommand) clean.command = (s.command as string[]).slice(0, 32)
    if (url) clean.url = url
    if (s.env && typeof s.env === "object" && !Array.isArray(s.env)) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v
      }
      if (Object.keys(env).length > 0) clean.env = env
    }
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(s.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v
      }
      if (Object.keys(headers).length > 0) clean.headers = headers
    }
    if (typeof s.cwd === "string" && s.cwd.trim().length > 0) clean.cwd = s.cwd.trim()
    if (typeof s.timeoutMs === "number" && Number.isFinite(s.timeoutMs)) {
      clean.timeoutMs = Math.max(1_000, Math.min(600_000, Math.floor(s.timeoutMs)))
    }
    if (typeof s.oauth === "boolean") clean.oauth = s.oauth
    else if (s.oauth && typeof s.oauth === "object" && !Array.isArray(s.oauth)) {
      clean.oauth = s.oauth as NonNullable<TrayambakConfig["mcpServers"]>[string]["oauth"]
    }
    out[name] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Validate tool-call hook config: matcher groups with runnable commands.
 *  Malformed groups are dropped (a bad hook entry must never break turns). */
export function cleanToolHooks(raw: unknown): TrayambakConfig["hooks"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: NonNullable<TrayambakConfig["hooks"]> = {}
  for (const point of ["preToolUse", "postToolUse"] as const) {
    const groups = (raw as Record<string, unknown>)[point]
    if (!Array.isArray(groups)) continue
    const clean: NonNullable<NonNullable<TrayambakConfig["hooks"]>[typeof point]> = []
    for (const g of groups.slice(0, 20)) {
      if (!g || typeof g !== "object" || Array.isArray(g)) continue
      const rec = g as Record<string, unknown>
      const matcher = rec.matcher === undefined ? undefined : String(rec.matcher).slice(0, 200)
      const hooks: Array<{ command: string; timeoutSec?: number }> = []
      if (Array.isArray(rec.hooks)) {
        for (const h of rec.hooks.slice(0, 20)) {
          if (!h || typeof h !== "object" || Array.isArray(h)) continue
          const cmd = (h as Record<string, unknown>).command
          if (typeof cmd !== "string" || cmd.trim().length === 0) continue
          const t = (h as Record<string, unknown>).timeoutSec
          hooks.push({
            command: cmd.slice(0, 2000),
            ...(typeof t === "number" && Number.isFinite(t)
              ? { timeoutSec: Math.max(1, Math.min(120, Math.floor(t))) }
              : {}),
          })
        }
      }
      if (hooks.length > 0) clean.push(matcher === undefined ? { hooks } : { matcher, hooks })
    }
    if (clean.length > 0) out[point] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Keep the per-provider live-list cache small and string-only (config
 *  file hygiene: at most 9 backends × 150 ids). */
export function cleanModelCache(raw: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(raw).slice(0, 20)) {
    if (!Array.isArray(v)) continue
    const ids = v.filter((m): m is string => typeof m === "string" && m.trim().length > 0).slice(0, 150)
    if (ids.length > 0) out[k.toLowerCase()] = ids
  }
  return out
}

/** Strip env-style prefixes users paste with keys ("NVAPI_KEY nvapi-…",
 *  "Bearer sk-…", "hf_…" is kept as-is). A prefixed key 401s on every
 *  provider — observed live in CWD config ("NVAPI_KEY nvapi-kJS0…"). */
export function cleanApiKey(raw: string): string {
  const t = (raw ?? "").trim()
  for (const prefix of ["NVAPI_KEY ", "Bearer ", "bearer "]) {
    if (t.startsWith(prefix)) return t.slice(prefix.length).trim()
  }
  const eq = t.match(/^(?:NVAPI_KEY|API_KEY|HF_TOKEN)\s*=\s*(.+)$/i)
  if (eq && eq[1]) return eq[1].trim().replace(/^["']|["']$/g, "")
  return t.replace(/^["']|["']$/g, "")
}

function sanitizeConfig(cfg: TrayambakConfig): TrayambakConfig {
  const provider = cfg.provider ?? DEFAULTS.provider ?? "llamacpp"
  const numDefault = (val: unknown, fallback: number | undefined): number => {
    const n = Number(val)
    if (!Number.isNaN(n)) return n
    return fallback ?? 0
  }
  const safe: TrayambakConfig = {
    baseUrl: (() => {
      // Per-provider endpoint defaults (like pi's provider catalogs: each
      // backend knows its own API root; explicit config always wins).
      const defaults: Record<string, string> = {
        nvidia: "https://integrate.api.nvidia.com",
        "nvidia-nim": "https://integrate.api.nvidia.com",
        openai: "https://api.openai.com",
        xai: "https://api.x.ai",
        huggingface: "https://router.huggingface.co/v1",
        anthropic: "https://api.anthropic.com",
        google: "https://generativelanguage.googleapis.com/v1beta",
        ollama: "http://localhost:11434",
        custom: "http://localhost:8080",
        groq: "https://api.groq.com/openai/v1",
        mistral: "https://api.mistral.ai/v1",
        cerebras: "https://api.cerebras.ai/v1",
        together: "https://api.together.xyz/v1",
        deepinfra: "https://api.deepinfra.com/v1/openai",
        cohere: "https://api.cohere.com/compatibility/v1",
        perplexity: "https://api.perplexity.ai",
        openrouter: "https://openrouter.ai/api/v1",
        fireworks: "https://api.fireworks.ai/inference/v1",
        venice: "https://api.venice.ai/api/v1",
        azure: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments",
        "skt-gateway": "https://gateway.skt-ai-labs.example/v1",
      }
      const raw =
        provider !== "llamacpp" && defaults[provider] !== undefined
          ? cfg.baseUrl && cfg.baseUrl.length > 0
            ? cfg.baseUrl
            : defaults[provider]
          : typeof cfg.baseUrl === "string" && cfg.baseUrl.length > 0
            ? cfg.baseUrl
            : DEFAULTS.baseUrl
      return raw.replace(/\/+$/, "").replace(/\/v1$/, "")
    })(),
    model: (() => {
      const defaults: Record<string, string> = {
        nvidia: "nvidia/nemotron-3-super-120b-a12b",
        "nvidia-nim": "nvidia/nemotron-3-super-120b-a12b",
        openai: "gpt-4o",
        xai: "grok-4",
        huggingface: "meta-llama/Llama-3.3-70B-Instruct",
        anthropic: "claude-3-5-sonnet-latest",
        google: "gemini-2.5-flash",
        ollama: "llama3.1",
        custom: "",
        groq: "llama-3.3-70b-versatile",
        mistral: "mistral-large-latest",
        cerebras: "llama3.1-70b",
        together: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        deepinfra: "meta-llama/Llama-3.3-70B-Instruct",
        cohere: "command-r-plus",
        perplexity: "sonar-pro",
        openrouter: "anthropic/claude-sonnet-4",
        fireworks: "accounts/fireworks/models/llama-v3p3-70b-instruct",
        venice: "llama-3.3-70b",
        azure: "gpt-4o",
        "skt-gateway": "auto",
      }
      if (provider !== "llamacpp" && defaults[provider] !== undefined) {
        const fallback = defaults[provider]
        // custom has no safe default model — require explicit config.
        if (provider === "custom") return typeof cfg.model === "string" ? cfg.model : ""
        return cfg.model && cfg.model.length > 0 && !cfg.model.endsWith(".gguf") ? cfg.model : fallback
      }
      return typeof cfg.model === "string" && cfg.model.length > 0 ? cfg.model : DEFAULTS.model
    })(),
    small_model:
      typeof cfg.small_model === "string" && cfg.small_model.trim().length > 0 ? cfg.small_model.trim() : undefined,
    subagent_model:
      typeof cfg.subagent_model === "string" && cfg.subagent_model.trim().length > 0
        ? cfg.subagent_model.trim()
        : undefined,
    apiKey: cleanApiKey(typeof cfg.apiKey === "string" ? cfg.apiKey : DEFAULTS.apiKey),
    cwd: typeof cfg.cwd === "string" && cfg.cwd.length > 0 ? path.resolve(cfg.cwd) : path.resolve(DEFAULTS.cwd),
    temperature: Math.max(0, Math.min(2, numDefault(cfg.temperature, DEFAULTS.temperature))),
    topP: Math.max(0, Math.min(1, numDefault(cfg.topP, DEFAULTS.topP))),
    maxTokens: Math.max(1, Math.min(1_000_000, numDefault(cfg.maxTokens, DEFAULTS.maxTokens))),
    contextWindow: Math.max(4_096, Math.min(2_000_000, numDefault(cfg.contextWindow, DEFAULTS.contextWindow))),
    timeoutMs: Math.max(1_000, Math.min(3_600_000, numDefault(cfg.timeoutMs, DEFAULTS.timeoutMs))),
    shellCommand:
      typeof cfg.shellCommand === "string" && cfg.shellCommand.trim().length > 0
        ? cfg.shellCommand.trim()
        : DEFAULTS.shellCommand,
    maxOutputLines: Math.max(1, Math.min(1_000_000, numDefault(cfg.maxOutputLines, DEFAULTS.maxOutputLines))),
    maxOutputBytes: Math.max(1, Math.min(500 * 1024 * 1024, numDefault(cfg.maxOutputBytes, DEFAULTS.maxOutputBytes))),
    maxTurns: Math.max(1, Math.min(10_000, numDefault(cfg.maxTurns, DEFAULTS.maxTurns))),
    maxToolCalls: Math.max(0, Math.min(1_000, numDefault(cfg.maxToolCalls, DEFAULTS.maxToolCalls))),
    budget: cleanBudget(cfg.budget),
    maxDistinctToolCalls: Math.max(
      0,
      Math.min(10_000, numDefault(cfg.maxDistinctToolCalls, DEFAULTS.maxDistinctToolCalls)),
    ),
    toolCallRate: Math.max(0, Math.min(100, numDefault(cfg.toolCallRate, DEFAULTS.toolCallRate))),
    maxRetries: Math.max(0, Math.min(10, numDefault(cfg.maxRetries, DEFAULTS.maxRetries))),
    retryDelayMs: Math.max(0, Math.min(60_000, numDefault(cfg.retryDelayMs, DEFAULTS.retryDelayMs))),
    maxParallelToolCalls: Math.max(
      1,
      Math.min(32, numDefault(cfg.maxParallelToolCalls, DEFAULTS.maxParallelToolCalls)),
    ),
    nativeTools: Boolean(cfg.nativeTools),
    modelPath: typeof cfg.modelPath === "string" && cfg.modelPath.trim().length > 0 ? cfg.modelPath.trim() : undefined,
    llamaCppBin:
      typeof cfg.llamaCppBin === "string" && cfg.llamaCppBin.trim().length > 0 ? cfg.llamaCppBin.trim() : undefined,
    mcpServers: cleanMcpServers(cfg.mcpServers),
    skillsDir: typeof cfg.skillsDir === "string" && cfg.skillsDir.trim().length > 0 ? cfg.skillsDir.trim() : undefined,
    agentProfileDirs: Array.isArray(cfg.agentProfileDirs)
      ? cfg.agentProfileDirs.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"].includes(cfg.reasoningEffort as string)
      ? (cfg.reasoningEffort as TrayambakConfig["reasoningEffort"])
      : DEFAULTS.reasoningEffort,
    scratchpadDir:
      typeof cfg.scratchpadDir === "string" && cfg.scratchpadDir.trim().length > 0
        ? path.resolve(cfg.scratchpadDir.trim())
        : path.resolve(process.cwd(), ".scratchpad"),
    developerMode: cfg.developerMode && typeof cfg.developerMode === "object" ? cfg.developerMode : undefined,
    permissions: cfg.permissions && typeof cfg.permissions === "object" ? cfg.permissions : undefined,
    provider: [
      "llamacpp",
      "nvidia",
      "nvidia-nim",
      "openai",
      "xai",
      "huggingface",
      "anthropic",
      "google",
      "ollama",
      "custom",
      "groq",
      "mistral",
      "cerebras",
      "together",
      "deepinfra",
      "cohere",
      "perplexity",
      "openrouter",
      "fireworks",
      "venice",
      "azure",
      "skt-gateway",
    ].includes(cfg.provider as string)
      ? (cfg.provider as TrayambakConfig["provider"])
      : DEFAULTS.provider,
    themeName: typeof cfg.themeName === "string" && cfg.themeName.trim().length > 0 ? cfg.themeName.trim() : undefined,
    questionDefaultOption:
      typeof cfg.questionDefaultOption === "number" && cfg.questionDefaultOption >= 1 && cfg.questionDefaultOption <= 9
        ? cfg.questionDefaultOption
        : DEFAULTS.questionDefaultOption,
    questionAnswerMode:
      typeof cfg.questionAnswerMode === "string" && ["both", "choose", "type"].includes(cfg.questionAnswerMode)
        ? (cfg.questionAnswerMode as "both" | "choose" | "type")
        : DEFAULTS.questionAnswerMode,
    codeFont: typeof cfg.codeFont === "string" && cfg.codeFont.trim().length > 0 ? cfg.codeFont.trim() : undefined,
    browserAutomationEnabled: Boolean(cfg.browserAutomationEnabled),
    browserAutomationHeadless: Boolean(cfg.browserAutomationHeadless),
    browserAutomationMaxPages: Math.max(
      1,
      Math.min(100, numDefault(cfg.browserAutomationMaxPages, DEFAULTS.browserAutomationMaxPages)),
    ),
    browserAutomationTimeoutMs: Math.max(
      1_000,
      Math.min(600_000, numDefault(cfg.browserAutomationTimeoutMs, DEFAULTS.browserAutomationTimeoutMs)),
    ),
    browserAutomationViewportWidth: Math.max(
      200,
      Math.min(7680, numDefault(cfg.browserAutomationViewportWidth, DEFAULTS.browserAutomationViewportWidth)),
    ),
    browserAutomationViewportHeight: Math.max(
      150,
      Math.min(4320, numDefault(cfg.browserAutomationViewportHeight, DEFAULTS.browserAutomationViewportHeight)),
    ),
    browserAutomationCaptureScreenshot: Boolean(cfg.browserAutomationCaptureScreenshot),
    mcpHealthCheckEnabled: Boolean(cfg.mcpHealthCheckEnabled),
    mcpHealthCheckIntervalMs: Math.max(
      5_000,
      Math.min(3_600_000, numDefault(cfg.mcpHealthCheckIntervalMs, DEFAULTS.mcpHealthCheckIntervalMs)),
    ),
    mcpToolCacheEnabled: Boolean(cfg.mcpToolCacheEnabled),
    mcpToolCacheTtlMs: Math.max(0, Math.min(3_600_000, numDefault(cfg.mcpToolCacheTtlMs, DEFAULTS.mcpToolCacheTtlMs))),
    mcpReconnectOnFailure: Boolean(cfg.mcpReconnectOnFailure),
    autoupdate: cfg.autoupdate === false || cfg.autoupdate === "notify" ? cfg.autoupdate : true,
    toolsets:
      cfg.toolsets && typeof cfg.toolsets === "object"
        ? {
            defaults: Array.isArray(cfg.toolsets.defaults)
              ? cfg.toolsets.defaults.filter((s): s is string => typeof s === "string")
              : (DEFAULTS.toolsets?.defaults ?? ["core"]),
            disabled: Array.isArray(cfg.toolsets.disabled)
              ? cfg.toolsets.disabled.filter((s): s is string => typeof s === "string")
              : [],
            platform:
              cfg.toolsets.platform && typeof cfg.toolsets.platform === "object" ? cfg.toolsets.platform : undefined,
          }
        : DEFAULTS.toolsets,
    modelFavorites: Array.isArray(cfg.modelFavorites)
      ? cfg.modelFavorites.filter((m): m is string => typeof m === "string" && m.trim().length > 0).slice(0, 50)
      : [],
    modelRecents: Array.isArray(cfg.modelRecents)
      ? cfg.modelRecents.filter((m): m is string => typeof m === "string" && m.trim().length > 0).slice(0, 20)
      : [],
    hooks: cleanToolHooks(cfg.hooks),
    modelCache:
      cfg.modelCache && typeof cfg.modelCache === "object" && !Array.isArray(cfg.modelCache)
        ? cleanModelCache(cfg.modelCache as Record<string, unknown>)
        : undefined,
    checkpointsEnabled: cfg.checkpointsEnabled === false ? false : true,
    memoryAutoExtract: cfg.memoryAutoExtract === false ? false : true,
    // License key: string passes through untouched (never
    // logged/printed — same rule as apiKey). Dropped here, the gates go
    // blind, so this passthrough is load-bearing, not cosmetic.
    licenseKey: typeof cfg.licenseKey === "string" && cfg.licenseKey.length > 0 ? cfg.licenseKey : undefined,
    // GitHub login: display identity (prompt + /github status), never a
    // secret. Dropped here, the operator block goes blind.
    githubLogin:
      typeof cfg.githubLogin === "string" && cfg.githubLogin.trim().length > 0
        ? cfg.githubLogin.trim().slice(0, 80)
        : undefined,
    // License server URL: passthrough with the same care (never logged).
    licenseServerUrl:
      typeof cfg.licenseServerUrl === "string" && cfg.licenseServerUrl.trim().length > 0
        ? cfg.licenseServerUrl.trim()
        : undefined,
    // Per-backend key store (`/provider key`): without this passthrough the
    // entries were silently dropped on every load, so switching backends
    // wiped saved keys. Keys are cleaned but never logged/printed.
    providers: Array.isArray(cfg.providers)
      ? cfg.providers
          .filter(
            (p): p is NonNullable<TrayambakConfig["providers"]>[number] =>
              !!p &&
              typeof p === "object" &&
              typeof (p as { id?: unknown }).id === "string" &&
              typeof (p as { baseUrl?: unknown }).baseUrl === "string",
          )
          .map((p) => ({
            ...p,
            apiKey: p.apiKey ? cleanApiKey(p.apiKey) : undefined,
          }))
          .slice(0, 20)
      : undefined,
    activeProviderId:
      typeof cfg.activeProviderId === "string" && cfg.activeProviderId.trim().length > 0
        ? cfg.activeProviderId.trim()
        : undefined,
    modeApiConfigs:
      cfg.modeApiConfigs && typeof cfg.modeApiConfigs === "object" && !Array.isArray(cfg.modeApiConfigs)
        ? Object.fromEntries(
            Object.entries(cfg.modeApiConfigs)
              .slice(0, 20)
              .filter(([, v]) => v && typeof v === "object"),
          )
        : undefined,
  }
  return safe
}

/**
 * Validate the session budget spec. Config rules: invalid values fall back
 * WITH a warning — never throw. Returns the normalized spec, or undefined
 * (no budget) when the value is missing or garbage.
 */
function cleanBudget(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const candidate = typeof raw === "number" ? String(raw) : raw
  if (typeof candidate !== "string") {
    console.warn(`trayambak: ignoring budget ${String(candidate)} — expected a spec like "50k" or "40 turns"`)
    return undefined
  }
  const spec = candidate.trim()
  if (spec === "") return undefined
  const parsed = parseTokenBudget(spec)
  if (!parsed.ok) {
    console.warn(`trayambak: ignoring budget "${spec}" — ${parsed.reason}`)
    return undefined
  }
  return spec
}
