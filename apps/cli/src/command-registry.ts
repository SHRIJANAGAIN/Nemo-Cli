/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Single source of truth for the CLI surface.
 *
 * The root help, per-command `--help`, unknown-flag validation and the
 * shell-completion scripts are ALL generated from this registry, so they
 * can never drift apart (the historic failure mode: a handwritten HELP
 * block that fell behind the dispatcher).
 */

import { logSecurityEvent } from "../../runtime/src/security-log.js"

export type FlagType = "string" | "boolean"

export interface CommandFlag {
  name: string
  type: FlagType
  description: string
  /** Value placeholder for help rendering, e.g. "<port>". */
  placeholder?: string
  /** Single-letter aliases, e.g. ["h"]. */
  aliases?: string[]
}

export interface CommandSpec {
  name: string
  /** One-line summary shown in the root help. */
  summary: string
  /** Usage line(s) for `<cmd> --help`. */
  usage?: string
  /** Long description for `<cmd> --help`. */
  description?: string
  /** Command-specific flags validated in strict mode. */
  flags?: CommandFlag[]
  examples?: string[]
  /** Hidden commands are excluded from help + completion. */
  hidden?: boolean
}

export const EXIT_OK = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2

/**
 * Operational failure with a printable message (missing session, failed
 * install, empty diff, ...): returns the message AND marks exit 1, so
 * failures can never masquerade as success (finding #31). Tests keep
 * asserting on the returned string; they additionally pin the code.
 */
export function failOutput(message: string): string {
  process.exitCode = EXIT_ERROR
  return message
}

/** Malformed invocation with a printable message: returns it, marks exit 2. */
export function usageOutput(message: string): string {
  process.exitCode = EXIT_USAGE
  return message
}
/** Policy denial: the check ran fine, the answer is no (CI-gatable). */
export const EXIT_DENIED = 3

/** Global flags accepted by every command that parses flags. */
export const GLOBAL_FLAGS: CommandFlag[] = [
  { name: "base-url", type: "string", description: "Provider base URL", placeholder: "<url>" },
  { name: "model", type: "string", description: "Model name/id to request", placeholder: "<name>", aliases: ["m"] },
  {
    name: "provider",
    type: "string",
    description: "Model provider: nvidia, nvidia-nim, ollama, llamacpp or custom",
    placeholder: "<name>",
  },
  { name: "cwd", type: "string", description: "Working directory for tools", placeholder: "<dir>", aliases: ["c"] },
  {
    name: "session",
    type: "string",
    description: "Persist the session transcript to a JSON file",
    placeholder: "<file>",
  },
  {
    name: "config",
    type: "string",
    description: "Use an alternate config file (NEMO_CONFIG)",
    placeholder: "<file>",
  },
  {
    name: "budget",
    type: "string",
    description: "Session budget: token cap (50k, 1.5M, 50000 tokens) or turn cap (40 turns); -1 disables",
    placeholder: "<spec>",
  },
  { name: "dev", type: "boolean", description: "Enable developer mode with advanced controls", aliases: ["dev-mode"] },
  {
    name: "alt-screen",
    type: "boolean",
    description:
      "Alternate screen mode (codex-style opt-in, default OFF: the alternate buffer has no scrollback, so resizes and repaints can never leave clones — the price is native history scroll). Default runs stay inline (scrollback is the transcript; the resize guard keeps it clone-free); --alt-screen forces the alternate buffer even over an ambient opt-out. In alt mode PageUp/PageDown and the mouse wheel page history in-app (footer shows ↑ distance from live; Enter snaps back)",
  },
  // No `--dump-system-prompt` flag, on purpose: the built system prompt is the
  // agent's core secret and must never be writable to stdout, a log or a CI
  // artifact. See the note in index.ts.
  { name: "help", type: "boolean", description: "Show help for this command", aliases: ["h"] },
  { name: "version", type: "boolean", description: "Print version", aliases: ["v"] },
]

/**
 * Hard refusal for `--dump-system-prompt`, kept here (next to the registry
 * that must never contain it) so the behavior is unit-testable without
 * running main() — main() has evalr side effects. Returns true when it
 * refused (caller must return immediately, before any command runs).
 *
 * LOCKED: the attempt is ALSO stored in the local security trail as a
 * prompt-exfiltration probe (`prompt_exfil_attempt`). The prompt itself is
 * never printed, logged, or persisted — only the fact that someone asked.
 * Repeated hits mean someone (or some script) is mining the system prompt.
 */
export function refuseSystemPromptDump(argv: readonly string[], binName: string): boolean {
  if (!argv.includes("--dump-system-prompt")) return false
  logSecurityEvent({ type: "prompt_exfil_attempt", source: "cli-flag", flag: "--dump-system-prompt" })
  process.stderr.write(
    `${binName}: --dump-system-prompt was removed — the system prompt is never printed, logged or persisted.\n`,
  )
  process.exitCode = 2
  return true
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "config",
    summary: "Manage configuration values",
    usage: "nemo config <get|set|list|path> [key] [value]",
    description:
      "Read or persist configuration values. Values are written atomically with 0600 permissions to the user config file.",
  },
  {
    name: "doctor",
    summary: "Diagnose the local environment",
    usage: "nemo doctor",
    description: "Checks node version, config integrity, provider credentials, binary availability and reports fixes.",
  },
  { name: "info", summary: "Show runtime & config summary", usage: "nemo info" },
  {
    name: "agent",
    summary: "Manage agent profiles",
    usage: "nemo agent <list|info|run> [type] [prompt]",
    description: "Lists bundled specialist personas (assets/agents) and project agents (.nemo/agents).",
  },
  {
    name: "task",
    summary: "Manage nemo tasks",
    usage: "nemo task <list|create|update|get|output|reset> [id] [content]",
  },
  { name: "todo", summary: "Manage session todos", usage: "nemo todo <list|add|update|clear|read> [content]" },
  {
    name: "plan",
    summary: "Manage multi-step plans",
    usage: "nemo plan <create|add-step|update-step|complete|list|show> [name] [description]",
  },
  {
    name: "manager",
    summary: "Show manager status",
    usage: "nemo manager <status|agents|tasks|plans|todos|summary>",
  },
  {
    name: "compact",
    summary: "Configure/run session compaction",
    usage: "nemo compact <config|estimate|run|reset>",
  },
  {
    name: "mode",
    summary: "Switch operating modes",
    usage: "nemo mode <list|current|set> [default|plan|architect|code|debug|review]",
  },
  {
    name: "worktree",
    summary: "List/switch git worktrees",
    usage: "nemo worktree <list|create|remove|switch> [path] [branch]",
  },
  {
    name: "harness",
    summary: "Show, evolve or apply the agent harness",
    usage: "nemo harness <show|init|run <task>|lessons|apply <task-id>> [--k N] [--mode parallel|sequential] [--domain D] [--source DIR]",
    description:
      "The harness is the system around the model: system prompt, guardrails, memory, skills, subagents. A session-end run evolves it autonomously; these actions are the manual escape hatch.",
  },
  {
    name: "mcp",
    summary: "Manage MCP servers & OAuth",
    usage: "nemo mcp <list|add|remove|auth|logout|status> [name] [url]",
  },
  {
    name: "marketplace",
    summary: "Browse/install shareable skills & agents",
    usage: "nemo marketplace <list|search|install|remove> [kind] [name|query] [--source <dir>]",
    flags: [{ name: "source", type: "string", description: "Marketplace shelf directory", placeholder: "<dir>" }],
  },
  {
    name: "upgrade",
    summary: "Update nemo and rebuild",
    usage: "nemo upgrade [version]",
    description: "Self-update via npm or git, then rebuild. Honors NEMO_DISABLE_AUTOUPDATE.",
  },
  {
    name: "serve",
    summary: "Start local llama.cpp server",
    usage: "nemo serve [--port <n>]",
    flags: [
      { name: "port", type: "string", description: "Listen port", placeholder: "<n>" },
      { name: "model-path", type: "string", description: "Path to GGUF model", placeholder: "<file>" },
    ],
  },
  { name: "download", summary: "Download a GGUF model", usage: "nemo download <model>" },
  {
    name: "acp",
    summary: "Run as ACP agent server (stdio JSON-RPC)",
    usage: "nemo acp",
    description: "Speaks the Agent Client Protocol over stdio for ACP-compatible editors (Zed, JetBrains, VS Code).",
  },
  {
    name: "web",
    summary: "Start HTTP agent API",
    usage: "nemo web [--port <n>] [--host <addr>] [--token <t>]",
    description:
      "Serves /api/sessions and /openapi.json. Binds 127.0.0.1 by default; bearer auth when --token/NEMO_WEB_TOKEN is set.",
    flags: [
      { name: "port", type: "string", description: "Listen port", placeholder: "<n>" },
      { name: "host", type: "string", description: "Bind address (default 127.0.0.1)", placeholder: "<addr>" },
      { name: "token", type: "string", description: "Bearer token for API access", placeholder: "<t>" },
    ],
  },
  { name: "login", summary: "Login / status", usage: "nemo login [--with-api-key <key>|status]" },
  { name: "logout", summary: "Logout (delete credentials)", usage: "nemo logout" },
  {
    name: "exec",
    summary: "Headless run, JSON events",
    usage: 'nemo exec "<prompt>" [--model <name>]',
    flags: [
      { name: "prompt", type: "string", description: "Prompt text", placeholder: "<text>", aliases: ["p"] },
      { name: "model", type: "string", description: "Model override", placeholder: "<name>" },
    ],
  },
  { name: "review", summary: "Review code/changes", usage: "nemo review [target]" },
  {
    name: "commit",
    summary: "Draft a commit message for the diff",
    usage: "nemo commit [--staged|--all]",
    flags: [
      { name: "staged", type: "boolean", description: "Use the staged diff (default)" },
      { name: "all", type: "boolean", description: "Use the full working-tree diff" },
    ],
  },
  { name: "stats", summary: "Show usage stats", usage: "nemo stats" },
  {
    name: "pr",
    summary: "Pull-request helpers (checkout/link/status)",
    usage: "nemo pr <checkout|link|unlink|status> [number|url]",
  },
  {
    name: "db",
    summary: "Inspect the local state store",
    usage: "nemo db <path|summary|threads|violations>",
  },
  { name: "uninstall", summary: "Remove launcher shims (keeps data)", usage: "nemo uninstall" },
  { name: "archive", summary: "Archive session", usage: "nemo archive <id>" },
  { name: "unarchive", summary: "Unarchive session", usage: "nemo unarchive <id>" },
  { name: "delete", summary: "Delete session", usage: "nemo delete <id>" },
  { name: "resume", summary: "Resume a stored session", usage: "nemo resume <session-id>" },
  {
    name: "export",
    summary: "Export session transcript",
    usage: "nemo export [id] [--format markdown|json|text]",
    flags: [{ name: "format", type: "string", description: "Output format", placeholder: "<markdown|json|text>" }],
  },
  { name: "mcp-server", summary: "Run MCP server (tools over stdio)", usage: "nemo mcp-server", hidden: false },
  { name: "modes", summary: "List agent modes (built-in + .roomodes)", usage: "nemo modes", hidden: false },
  {
    name: "checkpoint",
    summary: "Snapshot/list session checkpoints",
    usage: "nemo checkpoint <create|list> <session-id>",
    hidden: false,
  },
  {
    name: "sandbox",
    summary: "Check sandbox policy",
    usage: "nemo sandbox check <file> [--op read|write] [--policy <type>]",
    description:
      "Pure policy evaluation (workspace-write / read-only / external-sandbox / danger-full-access). Enforcement mode is reported honestly by `sandbox info`.",
  },
  {
    name: "execpolicy",
    summary: "Check exec policy",
    usage: "nemo execpolicy check <command>",
    description: "Checks a shell command against the ordered allow/deny exec rule engine.",
  },
  { name: "flags", summary: "List feature flags and overrides", usage: "nemo flags", hidden: false },
  {
    name: "client",
    summary: "Query or run the nemo local HTTP client",
    usage: "nemo client [health|run <prompt>]",
  },
  { name: "sdk", summary: "Start a thread via the TypeScript SDK", usage: "nemo sdk <prompt>" },
  {
    name: "completion",
    summary: "Print shell completion script",
    usage: "nemo completion <bash|zsh|fish|powershell>",
    description: "Prints a completion script for the given shell. Source it from your shell profile.",
  },
  {
    name: "run",
    summary: "Run a single prompt and exit",
    usage: 'nemo run "<prompt>" [--session <file>] [--model <name>]',
    flags: [
      { name: "prompt", type: "string", description: "Prompt text", placeholder: "<text>", aliases: ["p"] },
      { name: "model-path", type: "string", description: "Path to local GGUF model", placeholder: "<file>" },
      { name: "port", type: "string", description: "Server port", placeholder: "<n>" },
    ],
  },
  {
    name: "chat",
    summary: "Start an interactive session (default)",
    usage: "nemo [chat] [prompt]",
    hidden: true,
    flags: [
      { name: "prompt", type: "string", description: "Prompt text", placeholder: "<text>", aliases: ["p"] },
      { name: "model-path", type: "string", description: "Path to local GGUF model", placeholder: "<file>" },
      { name: "port", type: "string", description: "Server port", placeholder: "<n>" },
    ],
  },
]

/**
 * Accepted-but-hidden internal flags (spawned TUI child, eval harness).
 * They validate in strict mode but never appear in help/completion.
 */
export const INTERNAL_FLAGS: CommandFlag[] = [
  { name: "ink", type: "boolean", description: "internal: run the Ink TUI bridge" },
  { name: "evalr", type: "boolean", description: "internal: run the forced eval pass" },
]

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name)
}

export function visibleCommands(): CommandSpec[] {
  return COMMANDS.filter((c) => !c.hidden)
}

export function knownFlagNames(spec?: CommandSpec): string[] {
  const names = new Set<string>()
  for (const f of [...GLOBAL_FLAGS, ...INTERNAL_FLAGS]) {
    names.add(f.name)
    for (const a of f.aliases ?? []) names.add(a)
  }
  if (spec) {
    for (const f of spec.flags ?? []) {
      names.add(f.name)
      for (const a of f.aliases ?? []) names.add(a)
    }
  }
  return [...names]
}

/** accepted-name (canonical or alias) → value type, for strict parsing. */
export function flagTypeMap(spec?: CommandSpec): Map<string, "string" | "boolean"> {
  const map = new Map<string, "string" | "boolean">()
  const add = (f: CommandFlag): void => {
    map.set(f.name, f.type)
    for (const a of f.aliases ?? []) map.set(a, f.type)
  }
  for (const f of [...GLOBAL_FLAGS, ...INTERNAL_FLAGS]) add(f)
  if (spec) for (const f of spec.flags ?? []) add(f)
  return map
}

/** alias → canonical flag name, so `--m x` populates flags.model. */
export function flagAliasMap(spec?: CommandSpec): Map<string, string> {
  const map = new Map<string, string>()
  const add = (f: CommandFlag): void => {
    for (const a of f.aliases ?? []) if (a !== f.name) map.set(a, f.name)
  }
  for (const f of [...GLOBAL_FLAGS, ...INTERNAL_FLAGS]) add(f)
  if (spec) for (const f of spec.flags ?? []) add(f)
  return map
}

function pad(s: string, n: number): string {
  // Always leave at least one separating space: long usage lines can exceed
  // the target width, and a glued-on summary (`…[value]Manage configuration`)
  // reads as a typo.
  return s + " ".repeat(Math.max(1, n - s.length))
}

export function renderRootHelp(binName: string): string {
  const visible = visibleCommands()
  const renderUsage = (c: (typeof visible)[number]) =>
    (c.usage ?? `${binName} ${c.name}`).replace(/nemo/g, binName)
  const width = Math.min(48, Math.max(...visible.map((c) => renderUsage(c).length)) + 2)
  const rows = visible.map((c) => `  ${pad(renderUsage(c), width)}${c.summary}`)
  return `
NEMO  coding agent by Shrijan

Usage:
${rows.join("\n")}

Options:
${GLOBAL_FLAGS.filter((f) => f.name !== "help" && f.name !== "version")
  .map((f) => `  --${f.name}${f.placeholder ? " " + f.placeholder : ""}   ${f.description}`)
  .join("\n")}
  --version, -v      Print version
  --help, -h         Show this help

Help:
  ${binName} help <command>       Show detailed help for a command
  ${binName} <command> --help     Same as above

Environment:
  NEMO_BASE_URL, NEMO_MODEL, NEMO_API_KEY,
  NEMO_CWD, NEMO_PROVIDER, NEMO_AUTOUPDATE,
  NEMO_DISABLE_AUTOUPDATE, NEMO_CONFIG, NEMO_WEB_TOKEN,
  NEMO_WEB_ORIGINS, NEMO_BUDGET, NEMO_LOG (debug|info|warn|error),
  NEMO_LOG_FILE

Exit codes:
  0  success    1  runtime error    2  usage error
`
}

export function renderCommandHelp(spec: CommandSpec, binName: string): string {
  const parts: string[] = []
  parts.push(`${binName} ${spec.name} — ${spec.summary}`)
  if (spec.usage) parts.push(`\nUsage:\n  ${spec.usage.replace(/nemo/g, binName)}`)
  if (spec.description) parts.push(`\n${spec.description}`)
  const flags = spec.flags ?? []
  if (flags.length) {
    parts.push("\nCommand flags:")
    for (const f of flags) {
      const aliases = (f.aliases ?? []).map((a) => `-${a.length === 1 ? a : "-" + a}`).join(", ")
      parts.push(`  --${f.name}${f.placeholder ? " " + f.placeholder : ""}${aliases ? "  (" + aliases + ")" : ""}`)
      parts.push(`      ${f.description}`)
    }
  }
  parts.push("\nGlobal flags:")
  for (const f of GLOBAL_FLAGS) {
    if (f.name === "help" || f.name === "version") continue
    parts.push(`  --${f.name}${f.placeholder ? " " + f.placeholder : ""}   ${f.description}`)
  }
  if (spec.examples?.length) {
    parts.push("\nExamples:")
    for (const ex of spec.examples) parts.push(`  ${ex.replace(/nemo/g, binName)}`)
  }
  return parts.join("\n") + "\n"
}

/* ────────────────────────── shell completion ────────────────────────── */

const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"]

export function completionShells(): string[] {
  return [...COMPLETION_SHELLS]
}

export function completionScript(shell: string, binName: string): string {
  const names = visibleCommands().map((c) => c.name)
  const wordlist = names.join(" ")
  switch (shell) {
    case "bash":
      return `# nemo bash completion — install:
#   nemo completion bash > /etc/bash_completion.d/nemo
#   # or: nemo completion bash >> ~/.bashrc
_${binName}_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${wordlist} --help --version" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "${wordlist}" -- "$cur") )
  fi
}
complete -F _${binName}_complete ${binName}
[ "${binName}" = "nemo" ] && complete -F _${binName}_complete nemo
`
    case "zsh":
      return `#compdef ${binName} nemo
# nemo zsh completion — install:
#   nemo completion zsh > "\${fpath[1]}/_${binName}"  (then restart zsh)
_nemo() {
  local -a cmds
  cmds=(${names.join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' cmds
  fi
}
compdef _nemo ${binName}
`
    case "fish":
      return `# nemo fish completion — install:
#   nemo completion fish > ~/.config/fish/completions/${binName}.fish
${names.map((n) => `complete -c ${binName} -f -n '__fish_use_subcommand' -a '${n}'`).join("\n")}
`
    case "powershell":
      return `# nemo PowerShell completion — install (in $PROFILE):
#   nemo completion powershell | Out-File -Append $PROFILE
Register-ArgumentCompleter -Native -CommandName ${binName},nemo -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  @(${names.map((n) => `'${n}'`).join(", ")}) |
    Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`
    default:
      throw new Error(`unsupported shell: ${shell} (expected ${COMPLETION_SHELLS.join("|")})`)
  }
}
