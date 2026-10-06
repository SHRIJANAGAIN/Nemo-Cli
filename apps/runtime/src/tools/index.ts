/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { createBashTool } from "./command-exec/bash.js"
import { createTerminalTool } from "./command-exec/terminal.js"
import { createEditFileTool } from "./file-edit/edit-file.js"
import { createCheckpointTool, createRewindTool } from "./checkpoint/index.js"
import { createReadFileTool } from "./file-edit/read-file.js"
import { createViewImageTool } from "./file-edit/view-image.js"
import { createWriteFileTool } from "./file-edit/write-file.js"
import { createListDirTool } from "./directory/list-dir.js"
import { createGrepTool } from "./regex/grep.js"
import { createGlobTool } from "./globber/glob.js"
import { createCodeSearchTool } from "./code-search/code-search.js"
import { createSemanticSearchTool } from "./code-search/semantic-search.js"
import { createSymbolSearchTool } from "./code-search/symbols.js"
import { createFimTool } from "./code/fim.js"
import { createNextEditTool } from "./code/next-edit.js"
import { createCodemodeTool } from "./code/codemode.js"
import { createReadManifestTool } from "./manifest/read-manifest.js"
import { createDiffTool, createPatchTool } from "./text/diff.js"
import { createCsvTool } from "./text/csv.js"
import { createYamlTool } from "./text/yaml.js"
import { createSummarizeTool, createExtractTool } from "./text/summarize.js"
import { createWebFetchTool } from "./web/webfetch.js"
import { createWebBrowseTool } from "./web/webbrowse.js"
import { createWebSearchTool } from "./web/multi-search.js"
import { createTodoTool } from "./planning/todo.js"
import { createTodoReadTool } from "./planning/todoread.js"
import { createArtifactTool } from "./artifacts/artifact.js"
import { createGithubTool } from "./github/github.js"
import { createModeTool, createGetModeTool } from "./mode/mode.js"
import { createAskUserQuestionTool } from "./trayambak/ask-question.js"
import { createAgentTool } from "./trayambak/agent.js"
import { createTeamTool } from "./trayambak/team.js"
import { createSwarmTool } from "./trayambak/swarm.js"
import { createAgentCatalogTool } from "./trayambak/agent-catalog.js"
import { createCronCreateTool, createCronDeleteTool, createCronListTool } from "./trayambak/cron.js"
import { createMonitorTool } from "./trayambak/monitor.js"
import { createEnterWorktreeTool, createExitWorktreeTool } from "./trayambak/worktree.js"
import { createSendMessageTool } from "./trayambak/send-message.js"
import {
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskOutputTool,
} from "./trayambak/tasks.js"
import { createParallelReviewTool } from "./trayambak/parallel-review.js"
import { createParallelExecuteTool } from "./trayambak/parallel-execute.js"
import { createDebateTool } from "./trayambak/debate.js"
import { createFleetTool, type FleetLister } from "./trayambak/fleet.js"
import { createAgentManagerTool } from "./trayambak/agent-manager.js"
import { createSotaSolveTool } from "./trayambak/sota-solve.js"
import { createRunWorkflowTool } from "./trayambak/workflow.js"
import { createNotebookEditTool } from "./trayambak/notebook-edit.js"
import { createRulesTool } from "./trayambak/rules.js"
import { createGenerateAgentTool } from "./trayambak/generate-agent.js"
import { createPentestTools } from "./pentest/pentest-tools.js"
import * as fs from "fs"
import * as path from "path"
import type { TrayambakConfig } from "../config.js"
import { reportToolUsage, serverCanUsePentest } from "../license.js"
import { createMcpTools } from "./mcp/mcp.js"
import { createMarketplaceTool } from "./marketplace/marketplace.js"
import { createToolSearchTool } from "./mcp/tool-search.js"
import { createMcpInstallTool } from "./mcp/mcp-install.js"
import { createMcpRunnerTool } from "./mcp/mcp-runner-tool.js"
import { createSkillToolsFromRoots, bundledSkillsDir, defaultSkillsDir } from "./skills/skills.js"
import { loadCustomTools, registerCustomToolset } from "./custom/custom-tools.js"
import { createDiagnosticsTool } from "./diagnostics/diagnostics-tool.js"
import { createMemoryTool } from "./memory/memory.js"
import { createDreamTool } from "./memory/dream.js"
import type { Tool } from "./types.js"
import { textResult } from "./types.js"
import type { Provider } from "../../../../packages/provider/src/index.js"
import { FunctionRegistry, createFunctionRegistry } from "../../../../packages/function/src/index.js"
import { Arsenal } from "../../../../packages/core/src/toolsets/arsenal.js"
import type { ToolsetDefinition } from "../../../../packages/protocol/src/toolsets.js"
import { DEFAULT_TOOLSETS } from "../../../../packages/protocol/src/toolsets.js"

export { FunctionRegistry, createFunctionRegistry }

export * from "./types.js"
export { createBashTool } from "./command-exec/bash.js"
export {
  createTerminalTool,
  createTerminalSession,
  sendTerminalInput,
  readTerminalOutput,
  killTerminal,
  listTerminals,
  resetTerminalsForTests,
} from "./command-exec/terminal.js"
export { createReadFileTool } from "./file-edit/read-file.js"
export { createWriteFileTool } from "./file-edit/write-file.js"
export { createEditFileTool } from "./file-edit/edit-file.js"
export { createCheckpointTool } from "./checkpoint/checkpoint.js"
export { createRewindTool } from "./checkpoint/rewind.js"
export { createListDirTool } from "./directory/list-dir.js"
export { createGrepTool } from "./regex/grep.js"
export { createGlobTool } from "./globber/glob.js"
export { createCodeSearchTool } from "./code-search/code-search.js"
export { createSymbolSearchTool, extractSymbols, languageOf, searchSymbols } from "./code-search/symbols.js"
export type { SymbolHit, SymbolKind } from "./code-search/symbols.js"
export {
  createSemanticSearchTool,
  buildSemanticIndex,
  searchSemanticIndex,
  tokenize,
  formatSemanticResults,
} from "./code-search/semantic-search.js"
export type { SemanticDoc, ScoredDoc, SemanticIndex } from "./code-search/semantic-search.js"
export { createFimTool } from "./code/fim.js"
export { createNextEditTool, buildNextEditPrompt } from "./code/next-edit.js"
export { createCodemodeTool, runCodemode } from "./code/codemode.js"
export { createReadManifestTool } from "./manifest/read-manifest.js"
export { createDiffTool, createPatchTool, applyUnifiedPatch, unifiedDiff, diffLines } from "./text/diff.js"
export { createCsvTool, parseCsv } from "./text/csv.js"
export { createYamlTool, parseYamlComment } from "./text/yaml.js"
export { createSummarizeTool, createExtractTool, summarizeText } from "./text/summarize.js"
export { createWebFetchTool } from "./web/webfetch.js"
export { createWebBrowseTool } from "./web/webbrowse.js"
export { createWebSearchTool } from "./web/multi-search.js"
export { createTodoTool, loadTodoList } from "./planning/todo.js"
export { createTodoReadTool } from "./planning/todoread.js"
export {
  getContextBlock,
  loadMemory,
  saveMemory,
  addMemory,
  searchMemory,
  memoryMdPath,
  memoryJsonPath,
  memoryArchivePath,
} from "./memory/memory.js"
export type { MemoryEntry, MemoryFrontmatter } from "./memory/memory.js"

export { createMcpTools, resetMcpRegistry } from "./mcp/mcp.js"
export {
  createMarketplaceTool,
  scanMarketplace,
  searchMarketplace,
  installMarketplaceEntry,
  removeMarketplaceEntry,
  defaultMarketplaceSource,
} from "./marketplace/marketplace.js"
export type { MarketplaceEntry, MarketplaceKind } from "./marketplace/marketplace.js"
export { createToolSearchTool } from "./mcp/tool-search.js"
export { getConnectorRegistry, searchConnectors, ConnectorRegistry } from "./mcp/registry.js"
export type { ConnectorEntry } from "./mcp/registry.js"
export { createMcpInstallTool, listAvailableMcpServers, searchMcpServers, installMcpServer } from "./mcp/mcp-install.js"
export { createMcpRunnerTool, getMcpProcess, type McpProcess, type McpToolDefinition } from "./mcp/mcp-runner-tool.js"
export { createRulesTool, getRulesContextBlock, loadRules } from "./trayambak/rules.js"
export { createGenerateAgentTool } from "./trayambak/generate-agent.js"
export { createDiagnosticsTool } from "./diagnostics/diagnostics-tool.js"
export { createDreamTool, planDreamConsolidation, runDreamConsolidation } from "./memory/dream.js"
export type { Diagnostic } from "./diagnostics/tsc-diagnostics.js"
export {
  createSkillTools,
  createSkillToolsFromRoots,
  createSkillTool,
  loadSkillsFromDir,
  defaultSkillsDir,
  bundledSkillsDir,
  parseSkillFile,
  loadSkillsFromRoots,
} from "./skills/skills.js"
export type {
  SkillSpec,
  SkillMetadata,
  SkillPolicy,
  SkillInterface,
  SkillDependencies,
  LoadedSkills,
  SkillRootSnapshotCache,
} from "./skills/skills.js"
export { sanitizeSingleLine, repairFrontmatterScalarFields, validateSkillFrontmatter } from "./skills/skill-parser.js"
export { collectExplicitSkillMentions, selectSkillsFromMentions, normalizeSkillPath } from "./skills/skill-selection.js"
export { MemorySkillRootSnapshots } from "./skills/skill-loading.js"
export { createModeTool, createGetModeTool } from "./mode/mode.js"
export { createAskUserQuestionTool } from "./trayambak/ask-question.js"
export { createAgentTool } from "./trayambak/agent.js"
export { createTeamTool } from "./trayambak/team.js"
export { createSwarmTool } from "./trayambak/swarm.js"
export type { SwarmStrategy, SwarmTask, SwarmWorker } from "./trayambak/swarm.js"
export { createAgentCatalogTool } from "./trayambak/agent-catalog.js"
export { createNotebookEditTool } from "./trayambak/notebook-edit.js"
export {
  createCronCreateTool,
  createCronDeleteTool,
  createCronListTool,
  listCronJobs,
  tickCronJobs,
} from "./trayambak/cron.js"
export { createMonitorTool } from "./trayambak/monitor.js"
export { createEnterWorktreeTool, createExitWorktreeTool } from "./trayambak/worktree.js"
export { createSendMessageTool } from "./trayambak/send-message.js"
export {
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskOutputTool,
  listTasks,
  resetTasks,
} from "./trayambak/tasks.js"
export { createArtifactTool } from "./artifacts/artifact.js"
export { createGithubTool } from "./github/github.js"
export { createParallelReviewTool } from "./trayambak/parallel-review.js"
export { createDebateTool, buildDebateTasks, synthesizeDebate } from "./trayambak/debate.js"
export { createFleetTool, fleetListText, fleetPeekText } from "./trayambak/fleet.js"
export type { FleetJob, FleetLister } from "./trayambak/fleet.js"
export {
  createAgentManagerTool,
  formatAgentOverview,
  summarizeAgents,
  truncateAgentName,
} from "./trayambak/agent-manager.js"
export type { AgentSessionRow, AgentManagerDeps, AgentSummary } from "./trayambak/agent-manager.js"
export type { ParallelReviewResult, ReviewFinding } from "./trayambak/parallel-review.js"
export { createParallelExecuteTool } from "./trayambak/parallel-execute.js"
export type { ParallelExecuteOptions } from "./trayambak/parallel-execute.js"
export { createSotaSolveTool } from "./trayambak/sota-solve.js"
export {
  discoverAgentProfiles,
  getAgentProfile,
  findReviewersForFiles,
  findBuildResolversForLanguage,
} from "../agent/specialist-agents.js"
export { createPentestTools } from "./pentest/pentest-tools.js"
export type { AgentProfile, AgentCategory } from "../agent/specialist-agents.js"
export function createDefaultTools(
  devMode?: Partial<import("../developer-mode").DeveloperModeConfig>,
  onRunAgent?: (params: {
    description: string
    prompt: string
    subagentType?: string
    model?: string
    isolation?: string
    background?: boolean
  }) => Promise<string>,
  onRunTeam?: (
    tasks: Array<{
      name: string
      prompt: string
      subagentType?: string
      model?: string
      isolation?: string
      background?: boolean
    }>,
  ) => Promise<Array<{ name: string; text: string; error?: string }>>,
  onAskUserQuestion?: (
    questions: Array<{
      question: string
      header?: string
      options: Array<{ label: string; description?: string }>
      multi_select: boolean
    }>,
  ) => Promise<string[]>,
  config?: TrayambakConfig,
  onResolveSendTarget?: (to: string) => { id: string; name: string; running: boolean } | undefined,
  extra?: {
    onListFleet?: FleetLister
    onListSessions?: () => Array<{ id: string; name: string; status: string }>
    /** Live accessors for `get_mode` / `set_mode`. Without these the tools
     *  fall back to a closure-local mode so the pair stays self-consistent,
     *  but an Agent passes its own accessors so a mode switch actually takes
     *  effect (Agent.setMode refreshes the system prompt). */
    onGetMode?: () => string
    onSetMode?: (mode: string) => void
    /** Live provider accessor for the `fim` tool. Without it the tool
     *  reports FIM unavailable instead of guessing endpoint details. */
    onGetProvider?: () => Provider
  },
): { tools: Tool[]; arsenal?: Arsenal<Tool> } {
  // Closure-local fallback for callers that pass no mode accessors.
  let fallbackMode = extra?.onGetMode?.() ?? "default"
  const getMode = (): string => extra?.onGetMode?.() ?? fallbackMode
  const setMode = (mode: string): void => {
    if (extra?.onSetMode) extra.onSetMode(mode)
    else fallbackMode = mode
  }

  const allTools: Tool[] = [
    createBashTool(),
    createTerminalTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createViewImageTool(),
    createNotebookEditTool(),
    createCheckpointTool(),
    createRewindTool(),
    createListDirTool(),
    createGrepTool(),
    createGlobTool(),
    createCodeSearchTool(),
    createSemanticSearchTool(),
    createSymbolSearchTool(),
    createFimTool(extra?.onGetProvider),
    createNextEditTool(extra?.onGetProvider),
    createCodemodeTool(),
    createReadManifestTool(),
    ...(devMode?.webFetchEnabled !== false ? [createWebFetchTool()] : []),
    ...(devMode?.webSearchEnabled !== false ? [createWebSearchTool()] : []),
    createWebBrowseTool(),
    createDiffTool(),
    createPatchTool(),
    createCsvTool(),
    createYamlTool(),
    createSummarizeTool(),
    createExtractTool(),
    createTodoTool(),
    createTodoReadTool(),
    createArtifactTool(),
    createGithubTool(),
    createGetModeTool(getMode),
    createModeTool(getMode, setMode),
    createAskUserQuestionTool(onAskUserQuestion),
    createAgentTool(onRunAgent),
    createTeamTool(onRunTeam),
    createSwarmTool(onRunTeam),
    createParallelReviewTool(onRunTeam),
    createParallelExecuteTool(onRunTeam),
    createDebateTool(onRunTeam),
    createFleetTool(extra?.onListFleet),
    createAgentManagerTool({ onListSessions: extra?.onListSessions, onListFleet: extra?.onListFleet }),
    createSotaSolveTool(),
    createRunWorkflowTool(),
    createRulesTool(),
    createGenerateAgentTool(),
    ...createPentestTools(),
    createAgentCatalogTool(),
    createCronCreateTool(),
    createCronDeleteTool(),
    createCronListTool(),
    createMonitorTool(),
    createEnterWorktreeTool(),
    createExitWorktreeTool(),
    createSendMessageTool(undefined, { resolveTarget: onResolveSendTarget }),
    createTaskCreateTool(),
    createTaskUpdateTool(),
    createTaskGetTool(),
    createTaskListTool(),
    createTaskOutputTool(),
    createToolSearchTool(),
    createMarketplaceTool(),
    createMcpInstallTool(),
    createMcpRunnerTool(),
    createDiagnosticsTool(),
    createMemoryTool(),
    createDreamTool(),
  ]

  let arsenal: Arsenal<Tool> | undefined
  let tools = allTools
  if (config) {
    arsenal = buildArsenalFromConfig(config)
    tools = arsenal.resolveTools(allTools)
  }
  // License choke (single point, server-side): pentest tools stay registered
  // (prompt/toolset parity invariants forbid silent drops) but EVERY
  // execution passes TWO gates: developer mode ON (local, no network) and a
  // LIVE license check against the license server, and reports usage back
  // for the audit trail. No local checksum is trusted
  // for access — a forged code dies server-side as an unknown license.
  // The TUI menu explains this up front; this wrapper enforces it for
  // CLI/server/headless too.
  const gateLicenseKey = config?.licenseKey
  const gateServerUrl = config?.licenseServerUrl
  const gatePentest = (t: Tool): Tool => ({
    ...t,
    execute: async (toolCallId, args, signal, onUpdate, context) => {
      // Developer-mode master switch: pentest tools only run inside an
      // explicit devmode session. The license check below used to be the
      // only gate, so a live trial key executed scans with devmode OFF
      // (observed live) — and every refused call below skips the network
      // entirely, so OFF also means offline-quiet.
      if (config?.developerMode?.enabled !== true) {
        return textResult(
          `${t.definition.name} refused: developer mode is OFF — turn it on with /devmode on (pentest tools only run under an explicit devmode session).`,
          /*isError*/ true,
        )
      }
      const v = await serverCanUsePentest(gateLicenseKey, { serverUrl: gateServerUrl })
      if (v.valid !== true) {
        return textResult(
          `${t.definition.name} refused: ${v.reason ?? "no valid pentest license"} — bind a key with /devmode on 1102-XXXX-XXXX-XXXX (needs internet: the license is verified live).`,
          /*isError*/ true,
        )
      }
      const result = await t.execute(toolCallId, args, signal, onUpdate, context)
      const rawTarget = args !== null && typeof args === "object" ? (args as Record<string, unknown>).target : undefined
      void reportToolUsage(
        gateLicenseKey,
        {
          tool: t.definition.name,
          target: typeof rawTarget === "string" ? rawTarget : "",
          ok: result.isError !== true,
        },
        { serverUrl: gateServerUrl },
      )
      return result
    },
  })
  tools = tools.map((t) => (t.definition.name.startsWith("trayambak__Pentest") ? gatePentest(t) : t))

  return { tools, arsenal }
}

/**
 * Build the optional, config-driven tools (MCP servers + Skills) on top of the
 * default set - same extensibility as the reference agent projects.
 */
export async function buildOptionalTools(
  config: TrayambakConfig,
  baseTools: Tool[] = [],
  arsenal?: Arsenal<Tool>,
): Promise<Tool[]> {
  const tools: Tool[] = []
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    tools.push(...(await createMcpTools(config.mcpServers, config.mcpToolCacheTtlMs)))
  }
  // Skills: user/project root first, bundled fleet second (lowest
  // precedence — user files keep winning name collisions). The bundled
  // dir ships inside the install (dist/assets/skills), so npm users get
  // the same 290 skills without needing a ./skills checkout.
  {
    const primary = config.skillsDir ?? defaultSkillsDir()
    const bundled = bundledSkillsDir()
    const roots = [primary, ...(bundled && path.resolve(bundled) !== path.resolve(primary) ? [bundled] : [])]
    if (config.skillsDir || roots.some((r) => fs.existsSync(r))) {
      tools.push(...createSkillToolsFromRoots(roots))
    }
  }

  // User-defined tools: `.trayambak/{tool,tools}/*.{ts,js,mjs}` (SKT AI LABS's
  // `./tools` port). Built-ins and already-loaded tools are reserved so
  // custom files cannot shadow them.
  const customTools = await loadCustomTools({
    cwd: config.cwd ?? process.cwd(),
    reserved: [...baseTools, ...tools].map((t) => t.definition.name),
  })
  if (customTools.length > 0) {
    tools.push(...customTools)
    if (arsenal) {
      registerCustomToolset(
        arsenal,
        config,
        customTools.map((t) => t.definition.name),
      )
    }
  }

  if (arsenal) {
    // Generated per-server / per-skill tools are not in any static toolset
    // def — without this, resolveTools drops every mcp__* / skill__* name
    // (the "skills never reach the model" blackout). Merge them into the
    // mcp + skills toolsets so defaults like ["core", "mcp", "skills"] keep
    // working as the model-facing allowlist.
    const generated = [...baseTools, ...tools].filter(
      (t: Tool) => t.definition.name.startsWith("mcp__") || t.definition.name.startsWith("skill__"),
    )
    if (generated.length > 0) {
      const byName = (names: string[]): string[] => {
        const seen = new Set(names)
        for (const t of generated) seen.add(t.definition.name)
        return [...seen]
      }
      const mcpDef = arsenal.toolsetDefinition("mcp")
      if (mcpDef) {
        arsenal.registerToolset({
          ...mcpDef,
          toolNames: byName(
            mcpDef.toolNames.filter(
              (n) => !n.startsWith("mcp__") || ["tool_search", "mcp__install", "trayambak__run_mcp"].includes(n),
            ),
          ),
        })
      }
      const skillsDef = arsenal.toolsetDefinition("skills")
      if (skillsDef) {
        arsenal.registerToolset({
          ...skillsDef,
          toolNames: generated.filter((t) => t.definition.name.startsWith("skill__")).map((t) => t.definition.name),
        })
      }
    }
    const allResolved = [...baseTools, ...tools]
    return arsenal.resolveTools(allResolved)
  }
  return tools
}

export function toolDefinitions(tools: Tool[]) {
  return tools.map((t) => t.definition)
}

export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find((t) => t.definition.name === name)
}

/** Exported for the prompt/toolset parity test — a toolset entry naming a tool
 *  that is never registered silently drops it from the model's view. */
export const TOOLSET_DEFS: ToolsetDefinition[] = [
  {
    name: "core",
    description: "Core file, web, search, planning, and system tools",
    toolNames: [
      "bash",
      "terminal",
      "read_file",
      "write_file",
      "edit_file",
      "view_image",
      "trayambak__Checkpoint",
      "trayambak__Rewind",
      "list_dir",
      "grep",
      "glob",
      "code_search",
      "symbol_search",
      "semantic_search",
      "fim",
      "next_edit",
      "codemode",
      "read_manifest",
      "web_fetch",
      "web_search",
      "web_browse",
      "diff",
      "patch",
      "csv",
      "yaml",
      "summarize",
      "extract",
      "todo",
      "todoread",
      "diagnostics",
      "memory",
      "dream",
      "artifact",
      "github",
      "trayambak__AskUserQuestion",
      "set_mode",
      "get_mode",
    ],
  },
  {
    name: "agentic",
    description: "Agent delegation, planning, and execution tools",
    toolNames: [
      "trayambak__Agent",
      "trayambak__RunTeam",
      "skt__Swarm",
      "trayambak__Debate",
      "trayambak__ParallelReview",
      "trayambak__ParallelExecute",
      "sota_solve",
      "trayambak__RunWorkflow",
      "trayambak__NotebookEdit",
      "trayambak__GenerateAgent",
      "trayambak__AgentCatalog",
      "trayambak__Rules",
    ],
  },
  {
    name: "ops",
    description: "Operational tools: cron, monitoring, worktrees, messaging",
    toolNames: [
      "trayambak__CronCreate",
      "trayambak__CronDelete",
      "trayambak__CronList",
      "trayambak__Fleet",
      "trayambak__AgentManager",
      "trayambak__Monitor",
      "trayambak__EnterWorktree",
      "trayambak__ExitWorktree",
      "trayambak__SendMessage",
    ],
  },
  {
    name: "tasks",
    description: "Task management tools",
    toolNames: [
      "trayambak__TaskCreate",
      "trayambak__TaskUpdate",
      "trayambak__TaskGet",
      "trayambak__TaskList",
      "trayambak__TaskOutput",
    ],
  },
  {
    name: "pentest",
    description: "Security assessment toolkit",
    toolNames: [
      "trayambak__PentestListTools",
      "trayambak__PentestRunTool",
      "trayambak__PentestStartEngagement",
      "trayambak__PentestGetStatus",
      "trayambak__PentestGetFindings",
    ],
    checkFn: () => true,
  },
  {
    name: "mcp",
    description: "Model Context Protocol tools and installers",
    toolNames: ["tool_search", "marketplace", "mcp__install", "trayambak__run_mcp"],
  },
  {
    name: "skills",
    description: "Loaded skill tools",
    toolNames: [],
    checkFn: () => true,
  },
]

export function buildArsenalFromConfig(config: TrayambakConfig): Arsenal<Tool> {
  const cfg = config.toolsets
  // Pentest ships enabled: the config DEFAULTS predate the toolset, and a
  // defaults list without "pentest" filters the 5 Pentest* meta-tools out
  // before the model ever sees them (every security request then dies with
  // "Unknown tool"). Force it into the defaults; toolsets.disabled still
  // wins in resolveTools, so an explicit opt-out keeps working.
  const defaults = cfg?.defaults?.length ? cfg.defaults : DEFAULT_TOOLSETS
  const defaultToolsets = defaults.includes("pentest") ? defaults : [...defaults, "pentest"]
  const arsenal = new Arsenal<Tool>(
    {
      defaultToolsets,
      disabledToolsets: cfg?.disabled ?? [],
      platformToolsets: cfg?.platform,
    },
    config.provider ?? "default",
  )

  for (const def of TOOLSET_DEFS) {
    arsenal.registerToolset(def)
  }

  return arsenal
}

/** Build a FunctionRegistry pre-populated with the default tool set. */
export function buildFunctionRegistry(config?: TrayambakConfig): FunctionRegistry {
  const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, config)
  return createFunctionRegistry(tools)
}
