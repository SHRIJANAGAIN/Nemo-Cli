/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
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
import { createAskUserQuestionTool } from "./nemo/ask-question.js"
import { createAgentTool } from "./nemo/agent.js"
import { createTeamTool } from "./nemo/team.js"
import { createSwarmTool } from "./nemo/swarm.js"
import { createAgentCatalogTool } from "./nemo/agent-catalog.js"
import { createCronCreateTool, createCronDeleteTool, createCronListTool } from "./nemo/cron.js"
import { createMonitorTool } from "./nemo/monitor.js"
import { createEnterWorktreeTool, createExitWorktreeTool } from "./nemo/worktree.js"
import { createSendMessageTool } from "./nemo/send-message.js"
import {
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskOutputTool,
} from "./nemo/tasks.js"
import { createParallelReviewTool } from "./nemo/parallel-review.js"
import { createParallelExecuteTool } from "./nemo/parallel-execute.js"
import { createDebateTool } from "./nemo/debate.js"
import { createFleetTool, type FleetLister } from "./nemo/fleet.js"
import { createAgentManagerTool } from "./nemo/agent-manager.js"
import { createSotaSolveTool } from "./nemo/sota-solve.js"
import { createRunWorkflowTool } from "./nemo/workflow.js"
import { createNotebookEditTool } from "./nemo/notebook-edit.js"
import { createRulesTool } from "./nemo/rules.js"
import { createGenerateAgentTool } from "./nemo/generate-agent.js"
import * as fs from "fs"
import * as path from "path"
import type { NemoConfig } from "../config.js"
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
import { validateArguments } from "./validate-args.js"
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
export { createRulesTool, getRulesContextBlock, loadRules } from "./nemo/rules.js"
export { createGenerateAgentTool } from "./nemo/generate-agent.js"
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
export { createAskUserQuestionTool } from "./nemo/ask-question.js"
export { createAgentTool } from "./nemo/agent.js"
export { createTeamTool } from "./nemo/team.js"
export { createSwarmTool } from "./nemo/swarm.js"
export type { SwarmStrategy, SwarmTask, SwarmWorker } from "./nemo/swarm.js"
export { createAgentCatalogTool } from "./nemo/agent-catalog.js"
export { createNotebookEditTool } from "./nemo/notebook-edit.js"
export {
  createCronCreateTool,
  createCronDeleteTool,
  createCronListTool,
  listCronJobs,
  tickCronJobs,
} from "./nemo/cron.js"
export { createMonitorTool } from "./nemo/monitor.js"
export { createEnterWorktreeTool, createExitWorktreeTool } from "./nemo/worktree.js"
export { createSendMessageTool } from "./nemo/send-message.js"
export {
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskGetTool,
  createTaskListTool,
  createTaskOutputTool,
  listTasks,
  resetTasks,
} from "./nemo/tasks.js"
export { createArtifactTool } from "./artifacts/artifact.js"
export { createGithubTool } from "./github/github.js"
export { createParallelReviewTool } from "./nemo/parallel-review.js"
export { createDebateTool, buildDebateTasks, synthesizeDebate } from "./nemo/debate.js"
export { createFleetTool, fleetListText, fleetPeekText } from "./nemo/fleet.js"
export type { FleetJob, FleetLister } from "./nemo/fleet.js"
export {
  createAgentManagerTool,
  formatAgentOverview,
  summarizeAgents,
  truncateAgentName,
} from "./nemo/agent-manager.js"
export type { AgentSessionRow, AgentManagerDeps, AgentSummary } from "./nemo/agent-manager.js"
export type { ParallelReviewResult, ReviewFinding } from "./nemo/parallel-review.js"
export { createParallelExecuteTool } from "./nemo/parallel-execute.js"
export type { ParallelExecuteOptions } from "./nemo/parallel-execute.js"
export { createSotaSolveTool } from "./nemo/sota-solve.js"
export {
  discoverAgentProfiles,
  getAgentProfile,
  findReviewersForFiles,
  findBuildResolversForLanguage,
} from "../agent/specialist-agents.js"
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
  config?: NemoConfig,
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
  tools = tools.map((t) => validateArguments(t))

  return { tools, arsenal }
}

/**
 * Build the optional, config-driven tools (MCP servers + Skills) on top of the
 * default set - same extensibility as the reference agent projects.
 */
export async function buildOptionalTools(
  config: NemoConfig,
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

  // User-defined tools: `.nemo/{tool,tools}/*.{ts,js,mjs}` (Shrijan's
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
              (n) => !n.startsWith("mcp__") || ["tool_search", "mcp__install", "nemo__run_mcp"].includes(n),
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
      "nemo__Checkpoint",
      "nemo__Rewind",
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
      "nemo__AskUserQuestion",
      "set_mode",
      "get_mode",
    ],
  },
  {
    name: "agentic",
    description: "Agent delegation, planning, and execution tools",
    toolNames: [
      "nemo__Agent",
      "nemo__RunTeam",
      "nemo__Swarm",
      "nemo__Debate",
      "nemo__ParallelReview",
      "nemo__ParallelExecute",
      "sota_solve",
      "nemo__RunWorkflow",
      "nemo__NotebookEdit",
      "nemo__GenerateAgent",
      "nemo__AgentCatalog",
      "nemo__Rules",
    ],
  },
  {
    name: "ops",
    description: "Operational tools: cron, monitoring, worktrees, messaging",
    toolNames: [
      "nemo__CronCreate",
      "nemo__CronDelete",
      "nemo__CronList",
      "nemo__Fleet",
      "nemo__AgentManager",
      "nemo__Monitor",
      "nemo__EnterWorktree",
      "nemo__ExitWorktree",
      "nemo__SendMessage",
    ],
  },
  {
    name: "tasks",
    description: "Task management tools",
    toolNames: [
      "nemo__TaskCreate",
      "nemo__TaskUpdate",
      "nemo__TaskGet",
      "nemo__TaskList",
      "nemo__TaskOutput",
    ],
  },
  {
    name: "mcp",
    description: "Model Context Protocol tools and installers",
    toolNames: ["tool_search", "marketplace", "mcp__install", "nemo__run_mcp"],
  },
  {
    name: "skills",
    description: "Loaded skill tools",
    toolNames: [],
    checkFn: () => true,
  },
]

export function buildArsenalFromConfig(config: NemoConfig): Arsenal<Tool> {
  const cfg = config.toolsets
  const defaults = cfg?.defaults?.length ? cfg.defaults : DEFAULT_TOOLSETS
  const arsenal = new Arsenal<Tool>(
    {
      defaultToolsets: defaults,
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
export function buildFunctionRegistry(config?: NemoConfig): FunctionRegistry {
  const { tools } = createDefaultTools(undefined, undefined, undefined, undefined, config)
  return createFunctionRegistry(tools)
}
