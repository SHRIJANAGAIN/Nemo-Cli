/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { Agent, loadConfig, type TrayambakConfig } from "../../runtime/src/index.js"
import { VERSION } from "./version.js"
import {
  findCommand,
  flagAliasMap,
  flagTypeMap,
  knownFlagNames,
  refuseSystemPromptDump,
  renderRootHelp,
  renderCommandHelp,
  completionScript,
  completionShells,
} from "./command-registry.js"
import { logger } from "./logger.js"
import { configCommand } from "./commands/config.js"
import { downloadCommand } from "./commands/download.js"
import { doctorCommand, infoCommand } from "./commands/doctor.js"
import { runCommand } from "./commands/run.js"
import { serveCommand } from "./commands/serve.js"
import { agentCommand } from "./commands/agent.js"
import { taskCommand } from "./commands/task.js"
import { todoCommand } from "./commands/todo.js"
import { planCommand } from "./commands/plan.js"
import { managerCommand } from "./commands/manager.js"
import { compactCommand } from "./commands/compact.js"
import { modeCommand } from "./commands/mode.js"
import { worktreeCommand } from "./commands/worktree.js"
import { runMcpCli } from "./commands/mcp.js"
import { upgradeCommand } from "./commands/upgrade.js"
import { loginCommand, logoutCommand } from "./commands/login.js"
import { execCommand, reviewCommand } from "./commands/exec.js"
import { statsCommand } from "./commands/stats.js"
import { commitCommand } from "./commands/commit.js"
import { dbCommand } from "./commands/db.js"
import { prCommand } from "./commands/pr.js"
import { marketplaceCommand } from "./commands/marketplace.js"
import { uninstallCommand } from "./commands/uninstall.js"
import { archiveSession, unarchiveSession, deleteSession } from "./commands/archive.js"
import { resolveResumeTarget, sessionResumeCommand } from "./commands/session-resume.js"
import { sessionExportCommand } from "./commands/session-export.js"
import { sandboxCommand, execpolicyCommand } from "./commands/sandbox.js"
import { startServer } from "../../../packages/server/src/index.js"
import { runAcpServer } from "../../../packages/acp/src/index.js"
import { runMcpServer } from "../../../packages/mcp-server/src/index.js"

// VERSION is single-sourced from package.json via scripts/sync-version.mjs
// (runs automatically as part of `npm run build`).
// Invoked binary name for help text: bin/skt.cmd exports
// TRAYAMBAK_BIN_NAME=skt, otherwise this is trayambak.
const BIN_NAME = process.env.TRAYAMBAK_BIN_NAME === "skt" ? "skt" : "trayambak"

// Root help is generated from the command registry so it can never drift from the dispatcher.
const HELP = renderRootHelp(BIN_NAME)
import { parseFlags, portValue, type ParseResult } from "./flags.js"

export { parseFlags } from "./flags.js"

/** Thrown to leave main() with a specific exit code (no mistake journal). */
class EarlyExit extends Error {
  readonly code: number
  constructor(code: number, message = "early exit") {
    super(message)
    this.name = "EarlyExit"
    this.code = code
  }
}

/** Print a usage error and abort with exit code 2. */
function usageAbort(message: string): never {
  process.stderr.write(`${BIN_NAME}: ${message}\n`)
  throw new EarlyExit(2)
}

/**
 * Strictly parse `argv` against the command's registry entry: unknown
 * flags and missing values abort with exit code 2 (plus a --help hint).
 */
function strictParse(commandName: string, argv: string[]): ParseResult {
  const spec = findCommand(commandName)
  const result = parseFlags(argv, {
    known: new Set(knownFlagNames(spec)),
    types: flagTypeMap(spec),
    aliasMap: flagAliasMap(spec),
    strict: true,
  })
  if (result.errors.length > 0) {
    for (const e of result.errors) process.stderr.write(`${BIN_NAME}: ${e}\n`)
    process.stderr.write(`${BIN_NAME}: try \`${BIN_NAME} ${commandName} --help\`\n`)
    throw new EarlyExit(2)
  }
  return result
}

/** Validate an optional --port flag (absent → fallback/undefined). */
function optionalPort(raw: string | undefined, fallback?: number): number | undefined {
  if (raw === undefined) return fallback
  const port = portValue(raw)
  if (port === null) usageAbort(`invalid --port "${raw}" (expected an integer 1-65535)`)
  return port
}

/**
 * Journal rows as they exist on disk. `MistakeEntry` is the canonical shape,
 * but legacy journals also carry `status`/`title`/`description`/`id` aliases
 * that this path still reads, so every field is optional here.
 */
type JournalEntry = {
  errorId?: string
  id?: string
  errorName?: string
  title?: string
  errorDescription?: string
  errorParagraph?: string
  description?: string
  assistantOutput?: string
  userInput?: string
  whyAssistantDidIt?: string
  reasonItHeld?: string
  isUserMistake?: boolean
  isAssistantMistake?: boolean
  isDeviceError?: boolean
  howToResolve?: string
  futurePrevention?: string
  isFixed?: boolean
  status?: string
}

async function runForcedEvalrCheck(): Promise<void> {
  try {
    if (!process.argv.includes("--evalr")) return
    const quiet = process.argv.includes("--ink")
    const report = (message: string): void => {
      if (!quiet) process.stderr.write(message + "\n")
    }
    const evalModule = await import("../../../skt/5-eval/eval.js")
    const mistakeModule = await import("../../../skt/1-errors/mistake.js")
    const mistakes = mistakeModule.loadMistakes() as JournalEntry[]
    const unfixed = mistakes.filter((m) => !m.isFixed && m.status !== "fixed")
    if (unfixed.length > 0) {
      const template = evalModule.loadEvalrTemplate()
      if (template) {
        report("[EVALR] Forced Mistake Evaluation Required")
        const headers = template.split("\n").filter((l: string) => l.startsWith("###"))
        report("[EVALR] Questions: " + headers.join(" | "))
        for (const m of unfixed) {
          const errorId = m.errorId || m.id || "unknown"
          const errorName = m.errorName || m.title || "unnamed"
          const errorDescription = m.errorDescription || m.description || ""
          const errorParagraph = m.errorParagraph || m.description || ""
          evalModule.runForcedEvalr(errorId, {
            errorName: errorName,
            errorDescription: errorDescription,
            errorParagraph: errorParagraph,
            assistantOutput: m.assistantOutput || "",
            userInput: m.userInput || "",
            whyAssistantDidIt: m.whyAssistantDidIt || "",
            reasonItHeld: m.reasonItHeld || "",
            isUserMistake: m.isUserMistake || false,
            isAssistantMistake: m.isAssistantMistake || false,
            isDeviceError: m.isDeviceError || false,
            howToResolve: m.howToResolve || "",
            isFixed: false,
            whyFailed: "",
            futurePrevention: m.futurePrevention || "",
          })
          report("[EVALR] Mistake stored: " + errorName)
        }
      }
    }
  } catch (e) {
    if (!process.argv.includes("--ink")) {
      process.stderr.write(
        "[EVALR] Error during forced evaluation: " + (e instanceof Error ? e.message : String(e)) + "\n",
      )
    }
  }
}

async function main(): Promise<void> {
  await runForcedEvalrCheck()

  const [rawCommand, ...rest] = process.argv.slice(2)
  // Treat "--flag" in the command position (e.g. `trayambak --ink "hi"`)
  // as no command so flags land in parseFlags instead of triggering
  // "Unknown command: --ink".
  const command = rawCommand !== undefined && rawCommand.startsWith("-") ? undefined : rawCommand
  if (rawCommand === "--help" || rawCommand === "-h") {
    process.stdout.write(HELP)
    return
  }
  if (rawCommand === "help") {
    const target = rest[0]
    if (target === undefined) {
      process.stdout.write(HELP)
      return
    }
    const spec = findCommand(target)
    if (!spec) {
      process.stderr.write(`${BIN_NAME}: unknown command "${target}"\n`)
      process.exitCode = 2
      return
    }
    process.stdout.write(renderCommandHelp(spec, BIN_NAME))
    return
  }
  if (rawCommand === "--version" || rawCommand === "-v" || rawCommand === "version") {
    process.stdout.write(`${BIN_NAME} ${VERSION}\n`)
    return
  }
  // `<command> --help` for any registered command (including ones that
  // do their own argument parsing).
  if (command !== undefined && findCommand(command) && (rest.includes("--help") || rest.includes("-h"))) {
    process.stdout.write(renderCommandHelp(findCommand(command)!, BIN_NAME))
    return
  }
  // NOTE: there is deliberately no `--dump-system-prompt` flag. The system
  // prompt (tools + memory + rules + mode blocks) is the agent's most valuable
  // secret: printing it turns any local shell, CI log, crash artifact or
  // screenshot into a full spec of the agent's capabilities. It used to be
  // printed verbatim here and advertised in the flag registry + three docs.
  // To inspect prompt construction, read `buildSystemPrompt()` from a test —
  // never add a CLI port that writes it to stdout.
  //
  // Refused loudly rather than silently: an unrecognised flag in the command
  // position falls through to `case undefined:` and starts an empty chat, so
  // without this an old script would exit 0 having printed nothing and having
  // quietly opened an interactive session.
  if (refuseSystemPromptDump(process.argv, BIN_NAME)) {
    return
  }

  const overrides: Partial<TrayambakConfig> = {}
  const applyFlags = (flags: Record<string, string>) => {
    if (flags["base-url"]) overrides.baseUrl = flags["base-url"]
    if (flags.model) overrides.model = flags.model
    if (flags.provider) overrides.provider = flags.provider as TrayambakConfig["provider"]
    if (flags.cwd) overrides.cwd = flags.cwd
    // `--budget <spec>`: session budget (token/turn cap); loadConfig
    // validates it and runAgentLoop applies it on entry.
    if (flags.budget) overrides.budget = flags.budget
    // `--config <file>`: export as TRAYAMBAK_CONFIG so configPath() (and
    // every command that resolves config independently) honours it.
    if (flags.config) process.env.TRAYAMBAK_CONFIG = flags.config
    if (flags["dev"] === "true" || flags["dev-mode"] === "true") {
      overrides.developerMode = { ...(overrides.developerMode ?? {}), enabled: true }
    }
  }
  // Strict parse + apply the global flags in one step, so every
  // flag-parsing command gets the same override handling.
  const parseFor = (commandName: string, argv: string[]) => {
    const result = strictParse(commandName, argv)
    applyFlags(result.flags)
    return result
  }

  switch (command) {
    case "config":
      configCommand(rest)
      return
    case "doctor":
      await doctorCommand()
      return
    case "info":
      infoCommand()
      return
    case "agent": {
      const action = (rest[0] as "list" | "info" | "run") ?? "list"
      const type = rest[1]
      const prompt = rest.slice(2).join(" ")
      process.stdout.write(agentCommand({ action, type, prompt }) + "\n")
      return
    }
    case "task": {
      const action = (rest[0] as "list" | "create" | "update" | "get" | "output" | "reset") ?? "list"
      // Per-action mapping: `content: rest.slice(2)` dropped the first word
      // of every created task ("create buy milk" → queued "milk"), and
      // update's status (rest[2]) never reached taskCommand at all.
      let out: string
      if (action === "create") {
        out = taskCommand({ action, content: rest.slice(1).join(" ") })
      } else if (action === "update") {
        out = taskCommand({
          action,
          id: rest[1],
          status: rest[2] as "pending" | "in_progress" | "completed" | undefined,
        })
      } else {
        out = taskCommand({ action, id: rest[1] })
      }
      process.stdout.write(out + "\n")
      return
    }
    case "todo": {
      const action = (rest[0] as "list" | "add" | "update" | "clear" | "read") ?? "list"
      process.stdout.write(todoCommand({ action, content: rest.slice(1).join(" ") }) + "\n")
      return
    }
    case "plan": {
      const action = (rest[0] as "create" | "add-step" | "update-step" | "complete" | "list" | "show") ?? "list"
      // One positional shape for every action meant planId/stepId/status
      // NEVER reached planCommand from the CLI — `trayambak plan show <id>`
      // always answered "Missing plan id". Map each action explicitly.
      let out: string
      if (action === "create") {
        out = planCommand({ action, name: rest[1], description: rest.slice(2).join(" ") })
      } else if (action === "add-step") {
        out = planCommand({ action, planId: rest[1], stepDescription: rest.slice(2).join(" ") })
      } else if (action === "update-step") {
        out = planCommand({
          action,
          planId: rest[1],
          stepId: rest[2],
          status: rest[3] as "pending" | "in_progress" | "completed" | "blocked" | undefined,
          stepDescription: rest.length > 4 ? rest.slice(4).join(" ") : undefined,
        })
      } else if (action === "complete" || action === "show") {
        out = planCommand({ action, planId: rest[1] })
      } else {
        out = planCommand({ action })
      }
      process.stdout.write(out + "\n")
      return
    }
    case "manager": {
      const action = (rest[0] as "status" | "agents" | "tasks" | "plans" | "todos" | "summary") ?? "status"
      process.stdout.write(managerCommand({ action }) + "\n")
      return
    }
    case "compact": {
      const action = (rest[0] as "config" | "estimate" | "run" | "reset") ?? "config"
      process.stdout.write(compactCommand({ action }) + "\n")
      return
    }
    case "mode": {
      const action = (rest[0] as "list" | "current" | "set") ?? "list"
      process.stdout.write(
        modeCommand({
          action,
          mode: rest[1] as "default" | "plan" | "architect" | "code" | "debug" | "review" | undefined,
        }) + "\n",
      )
      return
    }
    case "worktree": {
      const action = (rest[0] as "list" | "create" | "remove" | "switch") ?? "list"
      process.stdout.write(worktreeCommand({ action, path: rest[1], branch: rest[2], name: rest[1] }) + "\n")
      return
    }
    case "mcp": {
      await runMcpCli(rest)
      return
    }
    case "marketplace": {
      const { flags, positional } = parseFor("marketplace", rest)
      const [action, kind, nameOrQuery] = positional
      process.stdout.write(marketplaceCommand({ action, kind, nameOrQuery, source: flags.source }) + "\n")
      return
    }
    case "serve": {
      const { flags } = parseFor("serve", rest)
      await serveCommand({
        port: optionalPort(flags.port),
        model: flags.model,
      })
      return
    }
    case "download": {
      await downloadCommand(rest)
      return
    }
    case "acp": {
      runAcpServer()
      return
    }
    case "web": {
      const { flags } = parseFor("web", rest)
      startServer({
        port: optionalPort(flags.port, 8787),
        host: flags.host ?? "127.0.0.1",
        token: flags.token,
      })
      // keep alive; startServer logs the URL
      await new Promise(() => {})
      return
    }
    case "login": {
      process.stdout.write((await loginCommand(rest)) + "\n")
      return
    }
    case "logout": {
      process.stdout.write((await logoutCommand()) + "\n")
      return
    }
    case "exec": {
      const { flags, positional } = parseFor("exec", rest)
      await execCommand(flags.prompt ?? positional.join(" "), { model: flags.model })
      return
    }
    case "review": {
      const { positional } = parseFor("review", rest)
      await reviewCommand(positional.join(" "))
      return
    }
    case "commit": {
      const { flags } = parseFor("commit", rest)
      const mode = flags.all === "true" ? "all" : "staged"
      process.stdout.write((await commitCommand({ mode })) + "\n")
      return
    }
    case "stats": {
      parseFor("stats", rest)
      process.stdout.write(statsCommand() + "\n")
      return
    }
    case "pr": {
      const action = rest[0] ?? "status"
      process.stdout.write((await prCommand(action, rest[1], process.cwd())) + "\n")
      return
    }
    case "db": {
      const action = rest[0] ?? "summary"
      process.stdout.write(dbCommand(action) + "\n")
      return
    }
    case "uninstall": {
      parseFor("uninstall", rest)
      process.stdout.write(uninstallCommand() + "\n")
      return
    }
    case "archive":
      process.stdout.write(archiveSession(rest[0] ?? "") + "\n")
      return
    case "unarchive":
      process.stdout.write(unarchiveSession(rest[0] ?? "") + "\n")
      return
    case "delete":
      process.stdout.write(deleteSession(rest[0] ?? "") + "\n")
      return
    case "resume": {
      const { flags, positional } = parseFor("resume", rest)
      const sessionId = positional[0]
      if (!sessionId) {
        process.stderr.write("Usage: trayambak resume <session-id> [prompt]\n")
        process.exitCode = 2
        return
      }
      // Resolve the transcript BEFORE reporting success. Printing "Resumed …"
      // and exiting was the original bug: the id resolved in the metadata list,
      // which carries no path to the conversation, so the agent that started
      // later began from an empty session and never saw the earlier turns.
      const target = resolveResumeTarget(sessionId)
      process.stdout.write(sessionResumeCommand({ sessionId }) + "\n")
      if (!target) {
        process.exitCode = 1
        return
      }
      // Continue straight into the session with the transcript attached, which
      // is the only way the history actually reaches the model.
      await runCommand({
        config: loadConfig(overrides),
        prompt: positional.slice(1).join(" ") || flags.prompt || "",
        sessionFile: target.file,
        modelPath: flags["model-path"],
        port: optionalPort(flags.port),
        useInk: true,
      })
      return
    }
    case "export": {
      const { flags, positional } = parseFor("export", rest)
      if (flags.format !== undefined && !["markdown", "json", "text"].includes(flags.format)) {
        usageAbort(`invalid --format "${flags.format}" (expected markdown|json|text)`)
      }
      const format: "markdown" | "json" | "text" =
        flags.format === "json" || flags.format === "text" ? flags.format : "markdown"
      process.stdout.write(sessionExportCommand({ sessionId: positional[0] ?? "", format }) + "\n")
      return
    }
    case "mcp-server":
      runMcpServer()
      return
    case "flags": {
      const { listFlags } = await import("../../../packages/core/src/feature_flags.js")
      const flags = listFlags()
      process.stdout.write(
        `${Object.entries(flags)
          .map(([name, on]) => `${on ? "on " : "off"} ${name}`)
          .join("\n")}\n`,
      )
      return
    }
    case "modes": {
      const { loadRoomodes, DEFAULT_MODES } = await import("../../../packages/modes/src/index.js")
      const custom = loadRoomodes(process.cwd())
      const all = [...custom, ...DEFAULT_MODES]
      process.stdout.write(all.map((m) => `${m.slug} — ${m.name} [${m.groups.join(",")}]`).join("\n") + "\n")
      return
    }
    case "checkpoint": {
      const { checkpointCommand } = await import("./commands/checkpoint.js")
      process.stdout.write(checkpointCommand(rest) + "\n")
      return
    }
    case "sandbox":
      process.stdout.write(sandboxCommand(rest) + "\n")
      return
    case "execpolicy":
      process.stdout.write(execpolicyCommand(rest) + "\n")
      return
    case "upgrade": {
      const output = await upgradeCommand({ target: rest[0] })
      process.stdout.write(output + "\n")
      return
    }
    case "completion": {
      const shell = (rest[0] ?? "").toLowerCase()
      if (!completionShells().includes(shell)) {
        usageAbort(`unsupported shell "${rest[0] ?? ""}" (expected ${completionShells().join("|")})`)
      }
      process.stdout.write(completionScript(shell, BIN_NAME))
      return
    }
    case "run": {
      const { flags, positional } = parseFor("run", rest)
      const config = loadConfig(overrides)
      await runCommand({
        config,
        prompt: flags.prompt ?? positional.join(" "),
        sessionFile: flags.session,
        modelPath: flags["model-path"],
        port: optionalPort(flags.port),
        useInk: true,
      })
      return
    }
    case undefined:
    case "chat": {
      const { flags, positional } = parseFor("chat", rest)
      const config = loadConfig(overrides)
      await runCommand({
        config,
        prompt: positional.join(" "),
        sessionFile: flags.session,
        modelPath: flags["model-path"],
        port: optionalPort(flags.port),
        useInk: true,
      })
      return
    }
    default:
      logger.warn(`unknown command: ${command}`, { command })
      process.stdout.write(`Unknown command: ${command}\n${HELP}`)
      process.exitCode = 2
  }
}

main().catch(async (err) => {
  // Usage errors / deliberate help+exit: message already printed, no
  // journal entry, no stack trace.
  if (err instanceof EarlyExit) {
    process.exitCode = err.code
    return
  }
  try {
    const { logMistake } = await import("../../../skt/1-errors/mistake.js")
    logMistake(
      "cli_fatal_error",
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err.stack || err.message : String(err),
      JSON.stringify(process.argv.slice(2)),
      `trayambak error: ${err instanceof Error ? err.stack : String(err)}`,
      0,
      "Fatal unhandled exception in CLI main",
      "Top-level catch in main()",
      /*isUserMistake*/ false,
      /*isAssistantMistake*/ true,
      /*isDeviceError*/ false,
      "Check stack trace and improve error handling",
    )
  } catch {
    // never let mistake logging kill the process
  }
  logger.error(`fatal: ${err instanceof Error ? err.message : String(err)}`, {
    stack: err instanceof Error ? err.stack : undefined,
    argv: process.argv.slice(2),
  })
  process.exitCode = 1
})
