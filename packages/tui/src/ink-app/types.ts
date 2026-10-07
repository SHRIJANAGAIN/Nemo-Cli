/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import type {
  AgentEvent,
  AgentMessage,
  Role,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolDefinition,
  ToolResult,
} from "../../../protocol/src/index.js"

export type { AgentEvent, AgentMessage, Role, TextPart, ThinkingPart, ToolCallPart, ToolDefinition, ToolResult }

export type PermissionMode = "read-only" | "plan" | "ask" | "auto-approve" | "full-access"

export interface MessagePart {
  text?: TextPart
  thinking?: ThinkingPart
  toolCall?: ToolCallPart
}

export interface TrayambakMessage {
  id: string
  timestamp: number
  role: Role
  content: string
  parts?: MessagePart[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  source?: string
  thinking?: string
  result?: string
  toolStatus?: "running" | "completed" | "error" | "pending"
  durationMs?: number
  /* Subagent ("task") card fields — set on transcript cards created for
   * subagent_start / subagent_background_start lifecycle events. */
  subagentId?: string
  subagentName?: string
  subagentType?: string
  subagentIsolation?: string
  subagentBackground?: boolean
  subagentState?: "running" | "completed" | "error"
  subagentToolCalls?: number
  subagentLastTool?: string
  subagentPrompt?: string
  subagentDurationMs?: number
  subagentDetail?: string
  /* TTL'd transient notice (addSystemMessage { ttlMs }): once the clock runs
   * out, the LIVE frame renders nothing for this row — while the messages
   * array, every index, and the <Static> scrollback copy stay untouched.
   * Never splice the row out: the print-once frontier indexes into this
   * array, and a removal would shift later ids and re-print history. */
  transientHidden?: boolean
}

export type ToolCallStatus = "pending" | "running" | "completed" | "error"

export interface ToolCallDisplay {
  id: string
  name: string
  args: Record<string, unknown>
  status: ToolCallStatus
  result?: string
  isError?: boolean
  durationMs?: number
  toolType?: "mcp" | "exec" | "builtin"
  server?: string
  command?: string
}

export type ToolCallRenderMode = "display" | "transcript"

export interface ChooserOption {
  value: string
  description: string
}

export interface SlashCommand {
  name: string
  description: string
  category: string
  chooser?: ChooserOption[]
}

export interface PermissionRequest {
  id: string
  tool: string
  reason: string
  args: Record<string, unknown>
  /** Sensitive operation — must be answered interactively, even under auto-approve. */
  forceAsk?: boolean
}

export type AppStatus = "idle" | "thinking" | "running" | "error"

export interface BackgroundSubagentState {
  id: string
  name: string
  prompt: string
  status: "running" | "completed" | "error" | "cancelled"
  result?: string
  error?: string
  startedAt: number
  completedAt?: number
  toolcalls?: number
  isolation?: string
  subagentType?: string
  /** Owning session: completions landing after /clear or newchat skip the
   *  transcript note instead of polluting the new session. */
  sessionId?: string | null
}

export interface StatusBarInfo {
  model: string
  permissionMode: PermissionMode
  status: AppStatus
  statusBarText?: string
  tokenCount?: number
  /** Model context window — drives the footer's `ctx N%` segment. */
  contextWindow?: number
  isStreaming?: boolean
  queuedCount?: number
  backgroundCount?: number
  /** Messages above the live window — drives the footer's `↑ N` chat-size
   *  chip ("how big is the chat upside"). Absent/0 at the top: the footer
   *  stays byte-identical to before. */
  scrollDepth?: number
  /** Running build version ("0.6.7") — drives the footer's `vX.Y.Z` chip so
   *  every screenshot identifies its build (ends "which version is this"
   *  ambiguity in bug reports). */
  version?: string
  /** Transient footer hint, e.g. "✓ task finished — Ctrl+B to view". */
  taskHint?: string
}

export function formatSubagentTitle(agent: string, description: string, background: boolean): string {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

/** Explicit tool-box width (no width="100%" on bordered boxes).
 *
 *  Measured: yoga draws this codebase's borders OUTSIDE the width, so a
 *  width="100%" tool box landed its right edge exactly ON the fullscreen
 *  frame's right border column (repro: corner ┐ at columns-1) — the box
 *  "escaped the conversation box". Geometry: tool origin is terminal col
 *  2 (static row margin 1 + message margin 1; col 3 when addMargin/grouped
 *  adds one more), frame inner ends at columns-2. termWidth-5 fits every
 *  nesting (common case keeps a 1-col gutter); floor 20 for absurd widths.
 */
export function toolBoxWidth(termWidth: number): number {
  return Math.max(20, termWidth - 5)
}

export function formatSubagentToolcalls(count: number): string {
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatCompletedSubagentDetail(toolcalls: number, duration: string): string {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  "read-only": "READ-ONLY",
  plan: "PLAN",
  ask: "ASK",
  "auto-approve": "AUTO",
  "full-access": "FULL",
}

export const STATUS_LABELS: Record<AppStatus, string> = {
  idle: "idle",
  thinking: "thinking",
  running: "running",
  error: "error",
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show all commands", category: "General" },
  { name: "about", description: "About Us: SKT AI LABS", category: "General" },
  { name: "keymap", description: "Show all keyboard shortcuts", category: "General" },
  { name: "enhance", description: "Rewrite your draft into a clearer prompt (Ctrl+E)", category: "General" },
  { name: "clear", description: "Reset the session", category: "Session" },
  { name: "exit", description: "Exit the session", category: "General" },
  { name: "quit", description: "Exit the session", category: "General" },
  { name: "model", description: "Show current model / pick from provider", category: "Model" },
  { name: "models", description: "List provider models", category: "Model" },
  {
    name: "provider",
    description: "Backend chooser: pick → key → live models → model (direct switch with saved key)",
    category: "Model",
  },
  { name: "theme", description: "Show or switch the color theme", category: "Display" },
  { name: "themes", description: "List available color themes", category: "Display" },
  { name: "bubble", description: "Re-render last reply in a themed bubble", category: "Display" },
  { name: "diff", description: "Show unified diff for a file", category: "Display" },
  { name: "code", description: "Render text as a code block", category: "Display" },
  { name: "md", description: "Render text as markdown", category: "Display" },
  { name: "status", description: "Show model, session, tokens, uptime", category: "Session" },
  {
    name: "queue",
    description: "List/drop prompts queued while the agent runs (/queue clear, /queue drop <n>)",
    category: "Session",
  },
  { name: "undo", description: "Restore the workspace to the previous checkpoint (Ctrl+Z)", category: "Session" },
  { name: "redo", description: "Re-apply the state that undo abandoned (Ctrl+Y)", category: "Session" },
  {
    name: "checkpoints",
    description: "List workspace checkpoints (/checkpoints prune confirm deletes all)",
    category: "Session",
  },
  {
    name: "checkpoint",
    description: "Checkpoints on/off switch",
    category: "Session",
    chooser: [
      { value: "on", description: "On — capture before every turn, /undo works (default)" },
      { value: "off", description: "Off — no captures, undo/redo report the state" },
      { value: "status", description: "Show on/off + stored points" },
    ],
  },
  { name: "compact", description: "Force context compaction (prune/truncate/fold old history)", category: "Session" },
  { name: "sessions", description: "List saved sessions", category: "Session" },
  { name: "resume", description: "Resume a previous session", category: "Session" },
  { name: "newchat", description: "Start a new conversation", category: "Session" },
  { name: "history", description: "Show recent session turns", category: "Session" },
  { name: "search", description: "Grep this session's transcript: /search <text>", category: "Session" },
  {
    name: "cron",
    description: "List scheduled cron jobs (model creates them; 60s scheduler fires them)",
    category: "Session",
  },
  { name: "stats", description: "Show message counts by role", category: "Session" },
  { name: "skills", description: "List installed skills", category: "Session" },
  { name: "todo", description: "Show the task checklist", category: "Session" },
  { name: "memory", description: "List persistent memory entries", category: "Session" },
  { name: "forget", description: "Mark history for deletion (type '/forget confirm')", category: "Session" },
  { name: "background", description: "Background subagents panel (Ctrl+B)", category: "Session" },
  {
    name: "agent",
    description: "Launch a subagent: /agent (picker), list, info <type>, run [--bg] <type> <prompt>",
    category: "Agent",
  },
  {
    name: "fork",
    description: "Fire-and-forget background subagent with this turn's context: /fork <directive>",
    category: "Agent",
  },
  {
    name: "review",
    description: "Principal-engineer review of changes: /review, /review commit <sha>, /review branch <name>",
    category: "Agent",
  },
  { name: "init", description: "Scan the repo and write/update AGENTS.md + durable memory", category: "Agent" },
  {
    name: "subagents",
    description: "Open the subagents panel — foreground + background tasks (Ctrl+S)",
    category: "Agent",
  },
  { name: "goal", description: "Set, show, or clear the persistent goal", category: "Session" },
  { name: "refine", description: "Review and apply verified self-improvement lessons", category: "Session" },
  { name: "expand", description: "Show last tool result in full", category: "Session" },
  { name: "mcp", description: "Manage MCP servers (search, install, list, info)", category: "Server" },
  {
    name: "permissions",
    description: "Toggle permission mode: read-only / plan / ask / auto / full-access",
    category: "Developer",
    chooser: [
      { value: "read-only", description: "Read-only — no writes, no edits (safest)" },
      { value: "plan", description: "Plan — explore only; mutations denied, model proposes a plan" },
      { value: "ask", description: "Ask — approval before writes/edits (default)" },
      { value: "auto-approve", description: "Auto-approve — writes/edits allowed" },
      { value: "full-access", description: "Full access — danger, no approvals needed" },
    ],
  },
  {
    name: "mode",
    description: "Permission mode stack: /mode <name> switches, /mode exit returns to the previous mode",
    category: "Developer",
  },
  {
    name: "gate",
    description: "Control repetition gate",
    category: "Developer",
    chooser: [
      { value: "on", description: "Enable gate" },
      { value: "off", description: "Disable gate" },
      { value: "status", description: "Show gate status" },
    ],
  },
  {
    name: "devmode",
    description: "Toggle developer mode — turning ON opens the pentest tools enable/disable menu (gate shown there)",
    category: "Developer",
  },
  {
    name: "question",
    description: "Set default question option (1-9) or answer mode (both/choose/type)",
    category: "Developer",
  },
  { name: "commands", description: "List built-in + custom prompt-file commands", category: "Session" },
  {
    name: "retry",
    description: "Re-send the last prompt (Ctrl+R loads it into the composer to edit)",
    category: "Session",
  },
  { name: "copy", description: "Copy the transcript to the clipboard (/copy, /copy last)", category: "Session" },
  { name: "doctor", description: "Run environment diagnostics", category: "Server" },
  {
    name: "github",
    description: "GitHub: login (browser opens), status, logout, issue <owner/repo#n>",
    category: "Server",
    chooser: [
      { value: "login", description: "Authorize via browser (auto-opens, CLI polls)" },
      { value: "status", description: "Show GitHub login state" },
      { value: "logout", description: "Forget this machine's token" },
      { value: "issue", description: "Read an issue — needs more: /github issue <owner/repo#n>" },
    ],
  },
]

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionRequest {
  id: string
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}
