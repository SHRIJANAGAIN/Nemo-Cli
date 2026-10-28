/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { McpOAuthConfig } from "../../../packages/mcp/src/oauth.js"
import { parseTokenBudget } from "../../../packages/core/src/token_budget.js"
import { isRemoteUncPath } from "../../../packages/core/src/validate.js"

/** Canonical UNC guard lives in core/validate.ts (shared choke point);
 *  re-exported here so existing importers (session.ts, session-manager.ts,
 *  config-unc.test.ts) keep working unchanged. */
export { isRemoteUncPath }
import { agentignoreDenyRules } from "./agentignore.js"

export interface NemoConfig {
  baseUrl: string
  model: string
  /** Cheap model for background chores (auto-titles). Falls back to `model` when unset. */
  small_model?: string
  /** Default model for subagent children. Falls back to the parent run's model when unset. */
  subagent_model?: string
  /** Decision-maker model for backend verdicts over local-LLM work (sota verify/attack).
   *  The user supplies one local model (e.g. a HuggingFace id served by llama.cpp/Ollama);
   *  enforced local-only like everything in cot/sota. Falls back to the worker model when unset. */
  judge_model?: string
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
  /**
   * Model-driven context compaction. When the head of the session is large
   * enough to be worth a model call, it is summarized into a structured
   * handoff (goal / files / errors / decisions / remaining work) instead of
   * a mechanical marker. Default ON.
   *
   * The deterministic compactor stays the guarantee: a failed or slow
   * summarizer degrades to the marker, so this only controls whether the
   * model is ASKED. Disable it to keep compaction model-free entirely.
   */
  agenticCompaction: boolean
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
  /** Model provider backend: "nvidia" or "nvidia-nim" (the hosted backend),
   *  "ollama" and "llamacpp" (local runtimes), or "custom"
   *  (bring-your-own OpenAI-compatible endpoint). */
  provider?: "llamacpp" | "nvidia" | "nvidia-nim" | "ollama" | "custom"
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
  /** Per-mode provider/model override (e.g. { debug: { provider: "ollama", model: "qwen2.5-coder" } }). */
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
  /** Active terminal theme name (e.g. "nemo-dark", "claude-dark", "claude-light"). */
  themeName?: string
  /** Animation level saved by /motion: "off" stops every timer, "reduced" keeps
   *  colour breathing but stops anything travelling, "full" is the default.
   *  Deliberately NOT folded into the NEMO_MOTION env merge below: that var
   *  means "this run", this field means "usually", and the TUI's motion policy is
   *  the one place that gets to put them in order. Flattening env into the config
   *  here would make a one-off capture run outrank the saved preference forever. */
  motion?: "off" | "reduced" | "full"
  /** Spinner style saved by /spinner ("braille", "arc", "meter", …). Free text
   *  like themeName: the name list lives with the frame tables in the TUI, and
   *  duplicating it here would let the two lists drift apart. An unrecognised
   *  name falls back to braille at paint time, the same way the env var does. */
  spinner?: string
  /** Default option number for AskUserQuestion (1-indexed). Pressing Enter without typing selects this option. Changeable by typing a different number. */
  questionDefaultOption?: number
  /** AskUserQuestion answer mode: "both" (choose by number or type custom), "choose" (number only), "type" (text only). Default "both". */
  questionAnswerMode?: "both" | "choose" | "type"
  /** Maximum number of times to auto-continue when the model response is cut off
   *  due to output token limit (stopReason === "length"). Each continuation adds
   *  a nudge turn. Default 10; set to 0 to disable. Bounded by budget/turns. */
  maxLengthContinuations?: number
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
  /** Root directory holding the company-employee definitions. Unset = feature idle. */
  companyDir?: string
  /** Master switch for the company-employee feature. Default false. */
  companyEnabled?: boolean
  /** Division ids switched off (effective list: config wins, else env). */
  companyDisabled?: string[]
  /** Model override applied ONLY to company personas. */
  companyModel?: string
  /** Keybinding overrides: action id -> chord list. Shape-sanitised on load;
   *  chord legality is decided by Keymap (packages/tui/src/keymap.ts). */
  keybindings?: Record<string, string[]>
  /** MCP tool cache TTL in milliseconds. Default 300000 (5 minutes). */
  mcpToolCacheTtlMs?: number
  /** MCP auto-reconnect: reconnect after transport failure. Default true. */
  mcpReconnectOnFailure?: boolean
  /** Auto-update policy (Shrijan parity): true = apply patch updates, false = never check, "notify" = only notify about updates. Default true. */
  autoupdate?: boolean | "notify"
  /** Autonomous harness improvement: at session end, re-run the session's last real request under candidate harnesses and adopt what won. Default true; NEMO_DISABLE_HARNESS_AUTO is the kill switch. */
  harnessAuto?: boolean
  /** License key for gated features (NEMO_LICENSE_KEY). Absent = gated features stripped. Never logged. */
  licenseKey?: string
  /** GitHub login from CLI OAuth (/github login). Display identity only — persisted so the system prompt can name the operator. Never a secret. */
  githubLogin?: string
  /** License server base URL (NEMO_LICENSE_SERVER). Default https://skt.sktailabs.in. Self-host to run your own registry. */
  licenseServerUrl?: string
}

const DEFAULTS: NemoConfig = {
  baseUrl: "https://integrate.api.nvidia.com",
  model: "nvidia/nemotron-3-super-120b-a12b",
  small_model: undefined,
  subagent_model: undefined,
  judge_model: undefined,
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
  agenticCompaction: true,
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
    ],
    askByDefault: true,
  },
  scratchpadDir: ".scratchpad",
  autoupdate: true,
  harnessAuto: true,
  provider: "nvidia",
  themeName: undefined,
  motion: undefined,
  spinner: undefined,
  questionDefaultOption: 1,
  questionAnswerMode: "both" as const,
  maxLengthContinuations: 10,
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
  // Company-employee switches are deliberately NOT defaulted here. `undefined`
  // means "no opinion", which is what lets resolveCompanyState fall through to
  // env and then to its own default-ON. A hard `false` would silently switch the
  // whole company off for anyone who never touched the setting.
  companyDisabled: [],
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
  const local = path.join(process.cwd(), ".nemo")
  // A bare `.nemo/` directory is NOT an opt-in: the app itself creates one for
  // harness/inbox state, and treating that as "this project has a config"
  // silently discarded the user's ~/.nemo/config.json (empty key, default
  // model). Only a project that actually ships a config file takes over.
  if (fs.existsSync(path.join(local, "config.json"))) return local
  return path.join(os.homedir(), ".nemo")
}

/**
 * True when the ACTIVE config file is `<cwd>/.nemo/config.json` rather than
 * the user's own `~/.nemo/config.json`.
 *
 * `configDir()` prefers the cwd copy so a project can ship defaults — but a
 * checkout is untrusted input (`git clone` + `cd` is all it takes), so that file
 * gets the reduced treatment in `stripRepoTrustedSettings`. `cwd === home` is
 * NOT a repo: there the two paths are one file and the user is at their own
 * prompt. An explicit `--config <file>` (NEMO_CONFIG) is trusted by
 * definition — the user named it.
 */
function isRepoLocalConfig(): boolean {
  if (process.env.NEMO_CONFIG) return false
  const local = path.join(process.cwd(), ".nemo")
  if (!fs.existsSync(path.join(local, "config.json"))) return false
  return path.resolve(local) !== path.resolve(os.homedir(), ".nemo")
}

/** Warn once per process per message — loadConfig runs on every turn. */
const warnedOnce = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return
  warnedOnce.add(key)
  console.warn(message)
}

/**
 * Risky working directories (#38) — RECONSTRUCTED, NOT THE ORIGINAL.
 *
 * A concurrent session's uncommitted version of this function was destroyed by a
 * careless `git checkout` in another session. This is a faithful rebuild from the
 * contract its regression test pins (config-unc.test.ts, "risky cwd warning
 * (#38)"), not the author's original code. The other session should replace it.
 *
 * The hazard: `--cwd /` or `NEMO_CWD=/etc` re-roots every path-relative tool
 * (read/write/edit/glob/grep) at a system location. Nothing stops it, so the only
 * defence is telling the operator, once, loudly enough to be noticed.
 *
 * Contract, from the test:
 *  - the filesystem ROOT always warns; an ordinary directory never does
 *  - the message contains "system location"
 *  - once per resolved path per process (loadConfig runs every turn, so an
 *    unconditional warn would spam the terminal every single turn)
 *  - a genuinely NEW risky path still warns even after another was warned
 */
const RISKY_CWD_WARNED = new Set<string>()

/**
 * True when the path is a filesystem ROOT (or empty) — the "C:\" / "/" case.
 *
 * Depth is what distinguishes it: a root has no meaningful name to compare and
 * is where every path-relative tool silently becomes a whole-filesystem tool. A
 * deep path like /etc or C:\Windows\System32 is a deliberate choice by someone
 * who typed it, and the test requires those to warn too (the second case), so
 * this predicate deliberately covers ONLY the root.
 */
function isFilesystemRoot(cwd: string): boolean {
  const trimmed = cwd.replace(/[\\/]+$/, "")
  if (trimmed.length === 0) return true
  return trimmed === path.parse(cwd).root.replace(/[\\/]+$/, "")
}

/**
 * System locations that are risky even though they are not the root.
 *
 * The test requires `path.join(root, "Windows")` on win32 and `/etc` elsewhere to
 * warn. Matching is case-insensitive and on a path SEGMENT boundary, so
 * `C:\Windows` warns but `C:\WindowsApps\Thing` (a real app directory) does not
 * false-positive on the substring.
 */
const RISKY_SYSTEM_DIRS = ["windows", "system32", "etc", "usr", "bin", "var", "boot", "proc", "sys"]

function isRiskySystemPath(cwd: string): boolean {
  if (isFilesystemRoot(cwd)) return true
  const segments = cwd.split(/[\\/]+/).filter((s) => s.length > 0)
  // Skip a drive-letter segment ("C:") — it is not a directory name.
  const dirs = segments.filter((s) => !/^[A-Za-z]:$/.test(s))
  return dirs.some((segment) => RISKY_SYSTEM_DIRS.includes(segment.toLowerCase()))
}

/** Warn once per process when the agent is rooted at a system location (#38). */
export function warnOnRiskyCwd(cwd: string): void {
  let resolved: string
  try {
    resolved = path.resolve(cwd)
  } catch {
    return
  }
  // A symlink launders the lexical check: <tmp>/link -> C:\Windows resolves
  // lexically inside tmp. Check the real target too; a missing/unreadable
  // target keeps the lexical answer.
  let real = resolved
  try {
    real = fs.realpathSync(resolved)
  } catch {
    /* lexical only */
  }
  const hit = isRiskySystemPath(resolved) ? resolved : isRiskySystemPath(real) ? real : null
  if (hit === null) {
    RISKY_CWD_WARNED.add(resolved)
    return
  }
  if (RISKY_CWD_WARNED.has(resolved) || RISKY_CWD_WARNED.has(real)) return
  RISKY_CWD_WARNED.add(resolved)
  RISKY_CWD_WARNED.add(real)
  console.warn(
    `nemo: cwd "${resolved}"${real !== resolved ? ` (resolves to "${real}")` : ""} is a system location. ` +
      `Every path-relative tool will read and write there. ` +
      `Point --cwd/NEMO_CWD at your project directory unless that is what you meant.`,
  )
}

/** Blanket-approval spellings, including the legacy ones (#93). */
const BLANKET_APPROVAL_UI_MODES = new Set(["full-access", "auto-approve"])

/**
 * Repo-local configs may ship scoped rules (including denies); they may not
 * hand the session blanket approval or choose the shell.
 *
 * - `uiMode: "full-access" | "auto-approve"` and the legacy `mode: "yolo"` /
 *   `askByDefault: false` all mean "run everything unprompted", and
 *   `evaluatePermission` short-circuits to `allow` for full-access before any
 *   rule is evaluated — so a committed file would be a one-command escape from
 *   every prompt.
 * - `shellCommand` is the interpreter behind every bash run, and an MSYS-linked
 *   shell is what downgrades a spawn out of AppContainer isolation
 *   (packages/sandbox/src/ac-workload.ts). The detected default stands in.
 *
 * Each removal is announced loudly and names the file, once per process.
 */
function stripRepoTrustedSettings(cfg: Partial<NemoConfig>, file: string): Partial<NemoConfig> {
  const out: Partial<NemoConfig> = { ...cfg }
  const perms = out.permissions
  if (perms && typeof perms === "object" && !Array.isArray(perms)) {
    const p = { ...(perms as Record<string, unknown>) }
    const uiMode = typeof p.uiMode === "string" ? p.uiMode : undefined
    const mode = typeof p.mode === "string" ? p.mode : undefined
    const blanket =
      (uiMode !== undefined && BLANKET_APPROVAL_UI_MODES.has(uiMode)) || mode === "yolo" || p.askByDefault === false
    if (blanket) {
      delete p.uiMode
      delete p.mode
      delete p.askByDefault
      warnOnce(
        `blanket:${file}`,
        `nemo: ignoring blanket-approval settings from ${file} — a repository ` +
          "cannot put the session into blanket-approval mode. Set it in " +
          "~/.nemo/config.json or point at a file you trust with --config instead.",
      )
    }
    out.permissions = p as NemoConfig["permissions"]
  }
  if (typeof out.shellCommand === "string" && out.shellCommand.trim().length > 0) {
    delete out.shellCommand
    warnOnce(
      `shell:${file}`,
      `nemo: ignoring shellCommand from ${file} — a repository cannot choose ` +
        "the shell the agent runs. Set NEMO_SHELL_COMMAND or put shellCommand " +
        "in ~/.nemo/config.json instead.",
    )
  }
  return out
}

/** `uiMode` outside its enum is dropped, wherever the config came from (#94). */
function sanitizeUIMode(perms: unknown, warn: boolean): NemoConfig["permissions"] {
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return undefined
  const p = { ...(perms as Record<string, unknown>) }
  if (p.uiMode !== undefined) {
    const allowed = ["read-only", "plan", "ask", "auto-approve", "full-access"]
    if (typeof p.uiMode !== "string" || !allowed.includes(p.uiMode)) {
      delete p.uiMode
      if (warn) {
        console.warn(
          `nemo: ignoring permissions.uiMode ${JSON.stringify(p.uiMode)} — expected one of ${allowed.join(", ")}`,
        )
      }
    }
  }
  return p as NemoConfig["permissions"]
}

export function configPath(): string {
  // Explicit override (NEMO_CONFIG, set by `--config <file>`):
  // resolve against the current directory so callers get one exact file.
  const explicit = process.env.NEMO_CONFIG
  if (explicit) {
    // #58: refuse a share BEFORE any fs probe. existsSync/readFileSync against
    // an attacker-chosen host would authenticate to it (NTLM hash leak) and
    // stall for seconds. Loud, never silent — the operator asked for this file.
    if (isRemoteUncPath(explicit)) {
      process.stderr.write(
        `nemo: refusing remote UNC config path ${JSON.stringify(explicit)} — ` +
          "config on a network share leaks credentials and cannot be written atomically. " +
          "Using the default config location instead.\n",
      )
    } else {
      return path.resolve(explicit)
    }
  }
  return path.join(configDir(), "config.json")
}

export function loadConfig(overrides: Partial<NemoConfig> = {}): NemoConfig {
  let fileConfig: Partial<NemoConfig> = {}
  const file = configPath()
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
      // Legacy tolerance: an older CLI path persisted flag names verbatim
      // ("--apiKey", "--baseUrl", "--provider", "--model"). Map them onto the
      // canonical keys when the canonical key is absent — observed live in
      // CWD .nemo/config.json, where the stray keys hid the real config
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
      fileConfig = raw as Partial<NemoConfig>
      // A checked-out repo's config is untrusted input: it may ship scoped
      // rules, never blanket approval or the shell (see the helper).
      if (isRepoLocalConfig()) fileConfig = stripRepoTrustedSettings(fileConfig, file)
    } catch {
      fileConfig = {}
    }
  }

  // Home mcpServers merge UNDER the active file, per server (#bug: a repo file
  // carrying `"mcpServers": {}` silently uninstalled every home server).
  // Only for the implicit <cwd>/.nemo/config.json — an explicit
  // --config file stands alone.
  if (!process.env.NEMO_CONFIG && isRepoLocalConfig()) {
    const homeFile = path.join(os.homedir(), ".nemo", "config.json")
    if (fs.existsSync(homeFile) && path.resolve(homeFile) !== path.resolve(file)) {
      try {
        const homeRaw = JSON.parse(fs.readFileSync(homeFile, "utf8")) as Record<string, unknown>
        const homeServers = cleanMcpServers(homeRaw.mcpServers)
        if (homeServers) {
          const mine = cleanMcpServers((fileConfig as Record<string, unknown>).mcpServers)
          fileConfig = { ...fileConfig, mcpServers: { ...homeServers, ...(mine ?? {}) } }
        }
      } catch {
        /* home config unreadable — the active file still applies */
      }
    }
  }

  const envConfig: Partial<NemoConfig> = {}
  if (process.env.NEMO_BASE_URL) envConfig.baseUrl = process.env.NEMO_BASE_URL
  if (process.env.NEMO_MODEL) envConfig.model = process.env.NEMO_MODEL
  if (process.env.NEMO_SMALL_MODEL) envConfig.small_model = process.env.NEMO_SMALL_MODEL
  if (process.env.NEMO_SUBAGENT_MODEL) envConfig.subagent_model = process.env.NEMO_SUBAGENT_MODEL
  // Company-employee library. Env is the operator's lever for a machine-wide
  // default; unset everywhere means one model does all the work.
  if (process.env.NEMO_COMPANY_DIR) envConfig.companyDir = process.env.NEMO_COMPANY_DIR
  if (process.env.NEMO_COMPANY_MODEL) envConfig.companyModel = process.env.NEMO_COMPANY_MODEL
  if (process.env.NEMO_COMPANY_DISABLED) {
    envConfig.companyDisabled = process.env.NEMO_COMPANY_DISABLED.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (process.env.NEMO_COMPANY_ENABLED !== undefined) {
    const v = process.env.NEMO_COMPANY_ENABLED.trim().toLowerCase()
    envConfig.companyEnabled = !(v === "0" || v === "false" || v === "off" || v === "no")
  }
  if (process.env.NEMO_JUDGE_MODEL) envConfig.judge_model = process.env.NEMO_JUDGE_MODEL
  if (process.env.NEMO_API_KEY) envConfig.apiKey = process.env.NEMO_API_KEY
  if (process.env.NEMO_CWD) envConfig.cwd = process.env.NEMO_CWD
  if (process.env.NEMO_TEMPERATURE) envConfig.temperature = Number(process.env.NEMO_TEMPERATURE)
  if (process.env.NEMO_TOP_P) envConfig.topP = Number(process.env.NEMO_TOP_P)
  if (process.env.NEMO_MAX_TOKENS) envConfig.maxTokens = Number(process.env.NEMO_MAX_TOKENS)
  if (process.env.NEMO_CONTEXT_WINDOW) envConfig.contextWindow = Number(process.env.NEMO_CONTEXT_WINDOW)
  if (process.env.NEMO_TIMEOUT_MS) envConfig.timeoutMs = Number(process.env.NEMO_TIMEOUT_MS)
  if (process.env.NEMO_SHELL_COMMAND) envConfig.shellCommand = process.env.NEMO_SHELL_COMMAND
  if (process.env.NEMO_MAX_OUTPUT_LINES) envConfig.maxOutputLines = Number(process.env.NEMO_MAX_OUTPUT_LINES)
  if (process.env.NEMO_MAX_OUTPUT_BYTES) envConfig.maxOutputBytes = Number(process.env.NEMO_MAX_OUTPUT_BYTES)
  if (process.env.NEMO_MAX_TURNS) envConfig.maxTurns = Number(process.env.NEMO_MAX_TURNS)
  if (process.env.NEMO_MAX_TOOL_CALLS) envConfig.maxToolCalls = Number(process.env.NEMO_MAX_TOOL_CALLS)
  if (process.env.NEMO_BUDGET) envConfig.budget = process.env.NEMO_BUDGET
  if (process.env.NEMO_MAX_DISTINCT_TOOL_CALLS)
    envConfig.maxDistinctToolCalls = Number(process.env.NEMO_MAX_DISTINCT_TOOL_CALLS)
  if (process.env.NEMO_TOOL_CALL_RATE) envConfig.toolCallRate = Number(process.env.NEMO_TOOL_CALL_RATE)
  if (process.env.NEMO_MAX_RETRIES) envConfig.maxRetries = Number(process.env.NEMO_MAX_RETRIES)
  if (process.env.NEMO_RETRY_DELAY_MS) envConfig.retryDelayMs = Number(process.env.NEMO_RETRY_DELAY_MS)
  if (process.env.NEMO_MAX_PARALLEL_TOOL_CALLS)
    envConfig.maxParallelToolCalls = Number(process.env.NEMO_MAX_PARALLEL_TOOL_CALLS)
  if (process.env.NEMO_NATIVE_TOOLS) envConfig.nativeTools = process.env.NEMO_NATIVE_TOOLS === "true"
  if (process.env.NEMO_SKILLS_DIR) envConfig.skillsDir = process.env.NEMO_SKILLS_DIR
  if (process.env.NEMO_AGENT_PROFILE_DIRS) {
    envConfig.agentProfileDirs = process.env.NEMO_AGENT_PROFILE_DIRS.split(path.delimiter).filter(Boolean)
  }
  if (process.env.NEMO_LLAMACPP_BIN) envConfig.llamaCppBin = process.env.NEMO_LLAMACPP_BIN
  if (process.env.NEMO_MCP_SERVERS) {
    try {
      envConfig.mcpServers = JSON.parse(process.env.NEMO_MCP_SERVERS) as NemoConfig["mcpServers"]
    } catch {
      /* ignore malformed env */
    }
  }
  // Project scope: ./.nemo/mcp.json merges under global config (project wins per-server).
  try {
    const projectMcp = path.join(process.cwd(), ".nemo", "mcp.json")
    if (fs.existsSync(projectMcp)) {
      const parsed = JSON.parse(fs.readFileSync(projectMcp, "utf8")) as { mcpServers?: Record<string, unknown> }
      const proj = cleanMcpServers(parsed.mcpServers ?? parsed)
      if (proj) envConfig.mcpServers = { ...(envConfig.mcpServers ?? {}), ...proj }
    }
  } catch {
    /* project MCP is best-effort */
  }
  if (process.env.NEMO_REASONING_EFFORT)
    envConfig.reasoningEffort = process.env.NEMO_REASONING_EFFORT as NemoConfig["reasoningEffort"]
  if (process.env.NEMO_SCRATCHPAD_DIR) envConfig.scratchpadDir = process.env.NEMO_SCRATCHPAD_DIR
  if (process.env.NEMO_PROVIDER) envConfig.provider = process.env.NEMO_PROVIDER as NemoConfig["provider"]
  if (!envConfig.modelPath && process.env.NEMO_MODEL_PATH) {
    envConfig.modelPath = process.env.NEMO_MODEL_PATH
  }
  if (process.env.NEMO_THEME) envConfig.themeName = process.env.NEMO_THEME
  if (process.env.NEMO_QUESTION_DEFAULT_OPTION)
    envConfig.questionDefaultOption = Number(process.env.NEMO_QUESTION_DEFAULT_OPTION)
  if (process.env.NEMO_QUESTION_ANSWER_MODE)
    envConfig.questionAnswerMode = process.env.NEMO_QUESTION_ANSWER_MODE as "both" | "choose" | "type"
  if (process.env.NEMO_CODE_FONT) envConfig.codeFont = process.env.NEMO_CODE_FONT
  if (process.env.NEMO_BROWSER_AUTOMATION_ENABLED)
    envConfig.browserAutomationEnabled = process.env.NEMO_BROWSER_AUTOMATION_ENABLED === "true"
  if (process.env.NEMO_BROWSER_AUTOMATION_HEADLESS)
    envConfig.browserAutomationHeadless = process.env.NEMO_BROWSER_AUTOMATION_HEADLESS === "true"
  if (process.env.NEMO_BROWSER_AUTOMATION_MAX_PAGES)
    envConfig.browserAutomationMaxPages = Number(process.env.NEMO_BROWSER_AUTOMATION_MAX_PAGES)
  if (process.env.NEMO_BROWSER_AUTOMATION_TIMEOUT_MS)
    envConfig.browserAutomationTimeoutMs = Number(process.env.NEMO_BROWSER_AUTOMATION_TIMEOUT_MS)
  if (process.env.NEMO_BROWSER_AUTOMATION_VIEWPORT_WIDTH)
    envConfig.browserAutomationViewportWidth = Number(process.env.NEMO_BROWSER_AUTOMATION_VIEWPORT_WIDTH)
  if (process.env.NEMO_BROWSER_AUTOMATION_VIEWPORT_HEIGHT)
    envConfig.browserAutomationViewportHeight = Number(process.env.NEMO_BROWSER_AUTOMATION_VIEWPORT_HEIGHT)
  if (process.env.NEMO_BROWSER_AUTOMATION_CAPTURE_SCREENSHOT)
    envConfig.browserAutomationCaptureScreenshot =
      process.env.NEMO_BROWSER_AUTOMATION_CAPTURE_SCREENSHOT === "true"
  if (process.env.NEMO_MCP_HEALTH_CHECK_ENABLED)
    envConfig.mcpHealthCheckEnabled = process.env.NEMO_MCP_HEALTH_CHECK_ENABLED === "true"
  if (process.env.NEMO_MCP_HEALTH_CHECK_INTERVAL_MS)
    envConfig.mcpHealthCheckIntervalMs = Number(process.env.NEMO_MCP_HEALTH_CHECK_INTERVAL_MS)
  if (process.env.NEMO_MCP_TOOL_CACHE_ENABLED)
    envConfig.mcpToolCacheEnabled = process.env.NEMO_MCP_TOOL_CACHE_ENABLED === "true"
  if (process.env.NEMO_MCP_TOOL_CACHE_TTL_MS)
    envConfig.mcpToolCacheTtlMs = Number(process.env.NEMO_MCP_TOOL_CACHE_TTL_MS)
  if (process.env.NEMO_MCP_RECONNECT_ON_FAILURE)
    envConfig.mcpReconnectOnFailure = process.env.NEMO_MCP_RECONNECT_ON_FAILURE !== "false"
  if (process.env.NEMO_AUTOUPDATE === "false" || process.env.NEMO_AUTOUPDATE === "0")
    envConfig.autoupdate = false
  else if (process.env.NEMO_AUTOUPDATE === "notify") envConfig.autoupdate = "notify"
  else if (process.env.NEMO_AUTOUPDATE === "true" || process.env.NEMO_AUTOUPDATE === "1")
    envConfig.autoupdate = true
  if (process.env.NEMO_HARNESS_AUTO !== undefined)
    envConfig.harnessAuto = !["false", "0", "off", "no"].includes(
      process.env.NEMO_HARNESS_AUTO.trim().toLowerCase(),
    )
  if (process.env.NEMO_LICENSE_KEY) envConfig.licenseKey = process.env.NEMO_LICENSE_KEY
  if (process.env.NEMO_LICENSE_SERVER) envConfig.licenseServerUrl = process.env.NEMO_LICENSE_SERVER

  const merged: NemoConfig = {
    ...DEFAULTS,
    ...fileConfig,
    ...envConfig,
    ...stripUndefined(overrides),
  }
  merged.cwd = path.resolve(merged.cwd)
  return sanitizeConfig(merged)
}

export function saveConfig(config: Partial<NemoConfig>): void {
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
  // No plaintext key at rest once the operator is in env mode: a key persisted
  // before the switch is stale by definition (env outranks the file at load),
  // so any save scrubs it instead of preserving it — otherwise the switch to
  // env mode silently leaves the old secret on disk.
  if (process.env.NEMO_API_KEY && typeof existing.apiKey === "string") {
    delete existing.apiKey
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
  if (process.env.NEMO_DEBUG_INPUT !== "1") return
  try {
    fs.appendFileSync("nemo-config.log", `${new Date().toISOString()} ${line}\n`)
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
export function cleanMcpServers(raw: unknown): NemoConfig["mcpServers"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: NonNullable<NemoConfig["mcpServers"]> = {}
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
    const clean: NonNullable<NemoConfig["mcpServers"]>[string] = {}
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
      clean.oauth = s.oauth as NonNullable<NemoConfig["mcpServers"]>[string]["oauth"]
    }
    out[name] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Validate tool-call hook config: matcher groups with runnable commands.
 *  Malformed groups are dropped (a bad hook entry must never break turns). */
/**
 * Action ids are at least two dotted lowercase segments: `tui.global.palette`,
 * `tui.input.submit`. A bare token like `single` is rejected — real ids are
 * namespaced by scope, and an unnamespaced one can never resolve to a command.
 * Empty, trailing-dot, leading-dot, double-dot and space-bearing ids are all
 * rejected by the same rule.
 */
const KEYBINDING_ACTION_ID = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/

/**
 * Coerce the untrusted `keybindings` config value into
 * `Record<actionId, string[]>`, or `undefined` when there is nothing usable.
 *
 * This is the untrusted-input boundary: the config file is hand-editable JSON,
 * so `"keybindings": "ctrl+p"` must be refused cleanly instead of crashing
 * startup. It deliberately does NOT decide which chords are LEGAL — that
 * policy lives in `Keymap` (packages/tui/src/keymap.ts), which reports its own
 * rejections so `/keymap` can explain them. Here we only guarantee the SHAPE
 * and the action-id grammar.
 */
export function sanitizeKeybindings(raw: unknown): Record<string, string[]> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: Record<string, string[]> = {}
  for (const [action, chords] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYBINDING_ACTION_ID.test(action)) continue
    if (!Array.isArray(chords)) continue
    const kept = chords.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    if (kept.length > 0) out[action] = kept
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Test-facing alias: the sanitiser is pure and safe to assert directly. */
export const sanitizeKeybindingsForTest = sanitizeKeybindings

export function cleanToolHooks(raw: unknown): NemoConfig["hooks"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const out: NonNullable<NemoConfig["hooks"]> = {}
  for (const point of ["preToolUse", "postToolUse"] as const) {
    const groups = (raw as Record<string, unknown>)[point]
    if (!Array.isArray(groups)) continue
    const clean: NonNullable<NonNullable<NemoConfig["hooks"]>[typeof point]> = []
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

/**
 * Out-of-range temperatures fall back to the default instead of clamping to
 * the edge: 2.0 is technically in-range but samples near-gibberish on most
 * models, so a misconfigured 2.7 must land on the safe default — not on the
 * wildest allowed value. Missing/NaN/non-numeric values fall back too.
 * Provider body-builders keep their own per-backend ceilings as backstop.
 */
function sanitizeTemperature(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 2) return DEFAULTS.temperature
  return n
}

function sanitizeConfig(cfg: NemoConfig): NemoConfig {
  const provider = cfg.provider ?? DEFAULTS.provider ?? "llamacpp"
  const numDefault = (val: unknown, fallback: number | undefined): number => {
    const n = Number(val)
    if (!Number.isNaN(n)) return n
    return fallback ?? 0
  }
  const safe: NemoConfig = {
    baseUrl: (() => {
      // Per-provider endpoint defaults (like pi's provider catalogs: each
      // backend knows its own API root; explicit config always wins).
      const defaults: Record<string, string> = {
        nvidia: "https://integrate.api.nvidia.com",
        "nvidia-nim": "https://integrate.api.nvidia.com",
        ollama: "http://localhost:11434",
        custom: "http://localhost:8080",
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
        ollama: "llama3.1",
        custom: "",
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
    judge_model:
      typeof cfg.judge_model === "string" && cfg.judge_model.trim().length > 0 ? cfg.judge_model.trim() : undefined,
    apiKey: cleanApiKey(typeof cfg.apiKey === "string" ? cfg.apiKey : DEFAULTS.apiKey),
    cwd: typeof cfg.cwd === "string" && cfg.cwd.length > 0 ? path.resolve(cfg.cwd) : path.resolve(DEFAULTS.cwd),
    temperature: sanitizeTemperature(cfg.temperature),
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
    // Booleans fall back to the default on anything non-boolean, matching the
    // repo rule that invalid config never throws.
    agenticCompaction:
      typeof cfg.agenticCompaction === "boolean" ? cfg.agenticCompaction : DEFAULTS.agenticCompaction,
    nativeTools: Boolean(cfg.nativeTools),
    // llama.cpp server sizing. These live in the config file (not just CLI
    // flags) so `nemo config set ctxSize 8192` round-trips instead of
    // being dropped by this rebuild and reported as an unknown key.
    ctxSize: Math.max(256, Math.min(4_194_304, numDefault(cfg.ctxSize, DEFAULTS.ctxSize))),
    batchSize: Math.max(1, Math.min(8192, numDefault(cfg.batchSize, DEFAULTS.batchSize))),
    ubatchSize: Math.max(1, Math.min(8192, numDefault(cfg.ubatchSize, DEFAULTS.ubatchSize))),
    modelPath: typeof cfg.modelPath === "string" && cfg.modelPath.trim().length > 0 ? cfg.modelPath.trim() : undefined,
    llamaCppBin:
      typeof cfg.llamaCppBin === "string" && cfg.llamaCppBin.trim().length > 0 ? cfg.llamaCppBin.trim() : undefined,
    mcpServers: cleanMcpServers(cfg.mcpServers),
    skillsDir: typeof cfg.skillsDir === "string" && cfg.skillsDir.trim().length > 0 ? cfg.skillsDir.trim() : undefined,
    agentProfileDirs: Array.isArray(cfg.agentProfileDirs)
      ? cfg.agentProfileDirs.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    reasoningEffort: ["low", "medium", "high", "xhigh", "max"].includes(cfg.reasoningEffort as string)
      ? (cfg.reasoningEffort as NemoConfig["reasoningEffort"])
      : DEFAULTS.reasoningEffort,
    scratchpadDir:
      typeof cfg.scratchpadDir === "string" && cfg.scratchpadDir.trim().length > 0
        ? path.resolve(cfg.scratchpadDir.trim())
        : path.resolve(process.cwd(), ".scratchpad"),
    developerMode: cfg.developerMode && typeof cfg.developerMode === "object" ? cfg.developerMode : undefined,
    permissions: sanitizeUIMode(cfg.permissions, /*warn*/ true),
    provider: ["llamacpp", "nvidia", "nvidia-nim", "ollama", "custom"].includes(cfg.provider as string)
      ? (cfg.provider as NemoConfig["provider"])
      : DEFAULTS.provider,
    themeName: typeof cfg.themeName === "string" && cfg.themeName.trim().length > 0 ? cfg.themeName.trim() : undefined,
    // Only the three canonical levels survive parsing: `/motion` normalises
    // spellings ("0", "static", "low") to one of them before saving, so a value
    // outside the set came from a hand-edit that cannot be trusted to mean what
    // it looks like. Dropping it falls back to the env/default policy.
    motion:
      typeof cfg.motion === "string" && ["off", "reduced", "full"].includes(cfg.motion)
        ? (cfg.motion as "off" | "reduced" | "full")
        : undefined,
    spinner:
      typeof cfg.spinner === "string" && cfg.spinner.trim().length > 0 ? cfg.spinner.trim().toLowerCase() : undefined,
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
    harnessAuto: cfg.harnessAuto !== false,
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
    keybindings: sanitizeKeybindings(cfg.keybindings),
    // Company-employee library. `companyEnabled` stays UNDEFINED when nobody
    // set it — that is "no opinion", so resolveCompanyState falls through to
    // env and then to its own default-ON. Coercing it to false here would
    // silently disable the whole company for every existing user.
    companyDir:
      typeof cfg.companyDir === "string" && cfg.companyDir.trim().length > 0 ? cfg.companyDir.trim() : undefined,
    companyEnabled: typeof cfg.companyEnabled === "boolean" ? cfg.companyEnabled : undefined,
    companyDisabled: Array.isArray(cfg.companyDisabled)
      ? cfg.companyDisabled.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
      : [],
    // Company-only model override. Blank/whitespace means "unset" so one model
    // does all the work (config.ts never invents a model).
    companyModel:
      typeof cfg.companyModel === "string" && cfg.companyModel.trim().length > 0 ? cfg.companyModel.trim() : undefined,
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
            (p): p is NonNullable<NemoConfig["providers"]>[number] =>
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
  // `.agentignore` (cwd): per-project credential deny-list, merged as
  // config-layer deny rules AFTER user config rules (deny beats allow in
  // the ladder; full-access still bypasses by design). Rebuilt from disk
  // on every loadConfig, so the file is never duplicated and edits apply
  // on the next load. Best-effort: a missing/unreadable file means [].
  try {
    const ignoreRules = agentignoreDenyRules(safe.cwd)
    if (ignoreRules.length > 0) {
      const perms = safe.permissions ?? {}
      safe.permissions = { ...perms, rulesV2: [...(perms.rulesV2 ?? []), ...ignoreRules] }
    }
  } catch {
    /* best effort */
  }
  // `/provider key` stores keys per backend in `providers[]`; the flat
  // `apiKey` only mirrors the active one. When the two drift (a saved profile
  // that was never re-applied) every turn died with "No NVIDIA API key
  // configured" while the key sat on disk.
  if (!safe.apiKey && safe.providers?.length) {
    const wanted = [safe.activeProviderId, safe.provider]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.toLowerCase())
    const entry =
      safe.providers.find((p) => wanted.includes(p.id.toLowerCase())) ??
      safe.providers.find((p) => p.type !== undefined && wanted.includes(p.type.toLowerCase()))
    if (entry?.apiKey) safe.apiKey = entry.apiKey
  }
  // Older builds shipped blanket `{tool: "write_file"|"edit_file", pattern: "*", allow: false}`
  // rules as DEFAULTS, and those rules were persisted into user configs. A
  // default-layer deny beats the approval ladder, so every write call died with
  // "permission denied by rule [default]" and the agent could not touch a file
  // at all — while the same rules never appeared in a fresh install that had no
  // saved config. Dropping them here upgrades those configs in place; scoped
  // denies (a real path pattern) are left alone.
  safe.permissions = stripStockWriteDenies(safe.permissions)
  warnOnRiskyCwd(safe.cwd)
  return safe
}

const STOCK_WRITE_DENY_TOOLS = new Set(["write_file", "edit_file"])

function isStockWriteDeny(tool: unknown, pattern: unknown, denied: boolean): boolean {
  if (!denied || typeof tool !== "string") return false
  if (!STOCK_WRITE_DENY_TOOLS.has(tool.toLowerCase())) return false
  return pattern === undefined || pattern === "" || pattern === "*"
}

function stripStockWriteDenies(
  perms: NemoConfig["permissions"],
): NemoConfig["permissions"] {
  if (!perms) return perms
  const rules = Array.isArray(perms.rules)
    ? perms.rules.filter((r) => !isStockWriteDeny(r.tool, r.pattern, r.allow === false))
    : perms.rules
  const rulesV2 = Array.isArray(perms.rulesV2)
    ? perms.rulesV2.filter((r) => !isStockWriteDeny(r.tool, r.pattern, r.action === "deny"))
    : perms.rulesV2
  if (rules === perms.rules && rulesV2 === perms.rulesV2) return perms
  return { ...perms, rules, rulesV2 }
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
    console.warn(`nemo: ignoring budget ${String(candidate)} — expected a spec like "50k" or "40 turns"`)
    return undefined
  }
  const spec = candidate.trim()
  if (spec === "") return undefined
  const parsed = parseTokenBudget(spec)
  if (!parsed.ok) {
    console.warn(`nemo: ignoring budget "${spec}" — ${parsed.reason}`)
    return undefined
  }
  return spec
}
