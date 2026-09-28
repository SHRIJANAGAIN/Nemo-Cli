/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
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

/** Global flags accepted by every command that parses flags. */
export const GLOBAL_FLAGS: CommandFlag[] = [
  { name: "base-url", type: "string", description: "Provider base URL", placeholder: "<url>" },
  { name: "model", type: "string", description: "Model name/id to request", placeholder: "<name>", aliases: ["m"] },
  {
    name: "provider",
    type: "string",
    description:
      "Model provider: nvidia, nvidia-nim, openai, anthropic, google, xai, huggingface, ollama, llamacpp or custom",
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
    description: "Use an alternate config file (TRAYAMBAK_CONFIG)",
    placeholder: "<file>",
  },
  { name: "dev", type: "boolean", description: "Enable developer mode with advanced controls", aliases: ["dev-mode"] },
  { name: "dump-system-prompt", type: "boolean", description: "Print the built system prompt and exit (diagnostics)" },
  { name: "help", type: "boolean", description: "Show help for this command", aliases: ["h"] },
  { name: "version", type: "boolean", description: "Print version", aliases: ["v"] },
]

export const COMMANDS: CommandSpec[] = [
  {
    name: "config",
    summary: "Manage configuration values",
    usage: "trayambak config <get|set|list|path> [key] [value]",
    description:
      "Read or persist configuration values. Values are written atomically with 0600 permissions to the user config file.",
  },
  {
    name: "doctor",
    summary: "Diagnose the local environment",
    usage: "trayambak doctor",
    description: "Checks node version, config integrity, provider credentials, binary availability and reports fixes.",
  },
  { name: "info", summary: "Show runtime & config summary", usage: "trayambak info" },
  {
    name: "agent",
    summary: "Manage agent profiles",
    usage: "trayambak agent <list|info|run> [type] [prompt]",
    description: "Lists bundled specialist personas (assets/agents) and project agents (.trayambak/agents).",
  },
  {
    name: "task",
    summary: "Manage trayambak tasks",
    usage: "trayambak task <list|create|update|get|output|reset> [id] [content]",
  },
  { name: "todo", summary: "Manage session todos", usage: "trayambak todo <list|add|update|clear|read> [content]" },
  {
    name: "plan",
    summary: "Manage multi-step plans",
    usage: "trayambak plan <create|add-step|update-step|complete|list|show> [name] [description]",
  },
  {
    name: "manager",
    summary: "Show manager status",
    usage: "trayambak manager <status|agents|tasks|plans|todos|summary>",
  },
  {
    name: "compact",
    summary: "Configure/run session compaction",
    usage: "trayambak compact <config|estimate|run|reset>",
  },
  {
    name: "mode",
    summary: "Switch operating modes",
    usage: "trayambak mode <list|current|set> [default|plan|architect|code|debug|review]",
  },
  {
    name: "worktree",
    summary: "List/switch git worktrees",
    usage: "trayambak worktree <list|create|remove|switch> [path] [branch]",
  },
  {
    name: "mcp",
    summary: "Manage MCP servers & OAuth",
    usage: "trayambak mcp <list|add|remove|auth|logout|status> [name] [url]",
  },
  {
    name: "upgrade",
    summary: "Update trayambak and rebuild",
    usage: "trayambak upgrade [version]",
    description: "Self-update via npm or git, then rebuild. Honors TRAYAMBAK_DISABLE_AUTOUPDATE.",
  },
  {
    name: "serve",
    summary: "Start local llama.cpp server",
    usage: "trayambak serve [--port <n>]",
    flags: [
      { name: "port", type: "string", description: "Listen port", placeholder: "<n>" },
      { name: "model-path", type: "string", description: "Path to GGUF model", placeholder: "<file>" },
    ],
  },
  { name: "download", summary: "Download a GGUF model", usage: "trayambak download <model>" },
  {
    name: "acp",
    summary: "Run as ACP agent server (stdio JSON-RPC)",
    usage: "trayambak acp",
    description: "Speaks the Agent Client Protocol over stdio for ACP-compatible editors (Zed, JetBrains, VS Code).",
  },
  {
    name: "web",
    summary: "Start HTTP agent API",
    usage: "trayambak web [--port <n>] [--host <addr>] [--token <t>]",
    description:
      "Serves /api/sessions and /openapi.json. Binds 127.0.0.1 by default; bearer auth when --token/TRAYAMBAK_WEB_TOKEN is set.",
    flags: [
      { name: "port", type: "string", description: "Listen port", placeholder: "<n>" },
      { name: "host", type: "string", description: "Bind address (default 127.0.0.1)", placeholder: "<addr>" },
      { name: "token", type: "string", description: "Bearer token for API access", placeholder: "<t>" },
    ],
  },
  { name: "login", summary: "Login / status", usage: "trayambak login [--with-api-key <key>|status]" },
  { name: "logout", summary: "Logout (delete credentials)", usage: "trayambak logout" },
  {
    name: "exec",
    summary: "Headless run, JSON events",
    usage: 'trayambak exec "<prompt>" [--model <name>]',
    flags: [
      { name: "prompt", type: "string", description: "Prompt text", placeholder: "<text>", aliases: ["p"] },
      { name: "model", type: "string", description: "Model override", placeholder: "<name>" },
    ],
  },
  { name: "review", summary: "Review code/changes", usage: "trayambak review [target]" },
  { name: "archive", summary: "Archive session", usage: "trayambak archive <id>" },
  { name: "unarchive", summary: "Unarchive session", usage: "trayambak unarchive <id>" },
  { name: "delete", summary: "Delete session", usage: "trayambak delete <id>" },
  { name: "resume", summary: "Resume a stored session", usage: "trayambak resume <session-id>" },
  {
    name: "export",
    summary: "Export session transcript",
    usage: "trayambak export [id] [--format markdown|json|text]",
    flags: [{ name: "format", type: "string", description: "Output format", placeholder: "<markdown|json|text>" }],
  },
  { name: "mcp-server", summary: "Run MCP server (tools over stdio)", usage: "trayambak mcp-server", hidden: false },
  { name: "modes", summary: "List agent modes (built-in + .roomodes)", usage: "trayambak modes", hidden: false },
  {
    name: "checkpoint",
    summary: "Snapshot/list session checkpoints",
    usage: "trayambak checkpoint <create|list> <session-id>",
    hidden: false,
  },
  {
    name: "sandbox",
    summary: "Check sandbox policy",
    usage: "trayambak sandbox check <file> [--op read|write] [--policy <type>]",
    description:
      "Pure policy evaluation (workspace-write / read-only / external-sandbox / danger-full-access). Enforcement mode is reported honestly by `sandbox info`.",
  },
  {
    name: "execpolicy",
    summary: "Check exec policy",
    usage: "trayambak execpolicy check <command>",
    description: "Checks a shell command against the ordered allow/deny exec rule engine.",
  },
  {
    name: "completion",
    summary: "Print shell completion script",
    usage: "trayambak completion <bash|zsh|fish|powershell>",
    description: "Prints a completion script for the given shell. Source it from your shell profile.",
  },
  {
    name: "run",
    summary: "Run a single prompt and exit",
    usage: 'trayambak run "<prompt>" [--session <file>] [--model <name>]',
    flags: [
      { name: "prompt", type: "string", description: "Prompt text", placeholder: "<text>", aliases: ["p"] },
      { name: "model-path", type: "string", description: "Path to local GGUF model", placeholder: "<file>" },
      { name: "port", type: "string", description: "Server port", placeholder: "<n>" },
    ],
  },
  {
    name: "chat",
    summary: "Start an interactive session (default)",
    usage: "trayambak [chat] [prompt]",
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
    (c.usage ?? `${binName} ${c.name}`).replace(/trayambak/g, binName)
  const width = Math.min(48, Math.max(...visible.map((c) => renderUsage(c).length)) + 2)
  const rows = visible.map((c) => `  ${pad(renderUsage(c), width)}${c.summary}`)
  return `
TRAYAMBAK  local-first terminal agent powered by NVIDIA NIM / llama.cpp

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
  TRAYAMBAK_BASE_URL, TRAYAMBAK_MODEL, TRAYAMBAK_API_KEY,
  TRAYAMBAK_CWD, TRAYAMBAK_PROVIDER, TRAYAMBAK_AUTOUPDATE,
  TRAYAMBAK_DISABLE_AUTOUPDATE, TRAYAMBAK_CONFIG, TRAYAMBAK_WEB_TOKEN,
  TRAYAMBAK_LOG (debug|info|warn|error), TRAYAMBAK_LOG_FILE

Exit codes:
  0  success    1  runtime error    2  usage error
`
}

export function renderCommandHelp(spec: CommandSpec, binName: string): string {
  const parts: string[] = []
  parts.push(`${binName} ${spec.name} — ${spec.summary}`)
  if (spec.usage) parts.push(`\nUsage:\n  ${spec.usage.replace(/trayambak/g, binName)}`)
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
    for (const ex of spec.examples) parts.push(`  ${ex.replace(/trayambak/g, binName)}`)
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
      return `# trayambak bash completion — install:
#   trayambak completion bash > /etc/bash_completion.d/trayambak
#   # or: trayambak completion bash >> ~/.bashrc
_${binName}_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${wordlist} --help --version" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "${wordlist}" -- "$cur") )
  fi
}
complete -F _${binName}_complete ${binName}
[ "${binName}" = "trayambak" ] && complete -F _${binName}_complete skt
`
    case "zsh":
      return `#compdef ${binName} skt
# trayambak zsh completion — install:
#   trayambak completion zsh > "\${fpath[1]}/_${binName}"  (then restart zsh)
_trayambak() {
  local -a cmds
  cmds=(${names.join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' cmds
  fi
}
compdef _trayambak ${binName}
`
    case "fish":
      return `# trayambak fish completion — install:
#   trayambak completion fish > ~/.config/fish/completions/${binName}.fish
${names.map((n) => `complete -c ${binName} -f -n '__fish_use_subcommand' -a '${n}'`).join("\n")}
`
    case "powershell":
      return `# trayambak PowerShell completion — install (in $PROFILE):
#   trayambak completion powershell | Out-File -Append $PROFILE
Register-ArgumentCompleter -Native -CommandName ${binName},skt -ScriptBlock {
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
