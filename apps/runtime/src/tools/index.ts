/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import { createBashTool } from "./command-exec/bash.js"
import { createEditFileTool } from "./file-edit/edit-file.js"
import { createCheckpointTool, createRewindTool } from "./checkpoint/index.js"
import { createReadFileTool } from "./file-edit/read-file.js"
import { createWriteFileTool } from "./file-edit/write-file.js"
import { createListDirTool } from "./directory/list-dir.js"
import { createGrepTool } from "./regex/grep.js"
import { createGlobTool } from "./globber/glob.js"
import { createCodeSearchTool } from "./code-search/code-search.js"
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
import { createGetModeTool } from "./mode/mode.js"
import { createAskUserQuestionTool } from "./trayambak/ask-question.js"
import { createAgentTool } from "./trayambak/agent.js"
import { createTeamTool } from "./trayambak/team.js"
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
import { createSotaSolveTool } from "./trayambak/sota-solve.js"
import { createRulesTool } from "./trayambak/rules.js"
import { createGenerateAgentTool } from "./trayambak/generate-agent.js"
import { createPentestTools } from "./pentest/pentest-tools.js"
import * as fs from "fs"
import type { TrayambakConfig } from "../config.js"
import { createMcpTools } from "./mcp/mcp.js"
import { createToolSearchTool } from "./mcp/tool-search.js"
import { createMcpInstallTool } from "./mcp/mcp-install.js"
import { createMcpRunnerTool } from "./mcp/mcp-runner-tool.js"
import { createSkillTools, defaultSkillsDir } from "./skills/skills.js"
import { loadCustomTools, registerCustomToolset } from "./custom/custom-tools.js"
import { createDiagnosticsTool } from "./diagnostics/diagnostics-tool.js"
import { createMemoryTool } from "./memory/memory.js"
import { createDreamTool } from "./memory/dream.js"
import type { Tool } from "./types.js"
import { Arsenal } from "../../../../packages/core/src/toolsets/arsenal.js"
import type { ToolsetDefinition } from "../../../../packages/protocol/src/toolsets.js"
import { DEFAULT_TOOLSETS } from "../../../../packages/protocol/src/toolsets.js"

export * from "./types.js"
export { createBashTool } from "./command-exec/bash.js"
export { createReadFileTool } from "./file-edit/read-file.js"
export { createWriteFileTool } from "./file-edit/write-file.js"
export { createEditFileTool } from "./file-edit/edit-file.js"
export { createCheckpointTool } from "./checkpoint/checkpoint.js"
export { createRewindTool } from "./checkpoint/rewind.js"
export { createListDirTool } from "./directory/list-dir.js"
export { createGrepTool } from "./regex/grep.js"
export { createGlobTool } from "./globber/glob.js"
export { createCodeSearchTool } from "./code-search/code-search.js"
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
  createSkillTool,
  loadSkillsFromDir,
  defaultSkillsDir,
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
export { createAgentCatalogTool } from "./trayambak/agent-catalog.js"
export { createEnterPlanModeTool } from "./trayambak/plan-mode.js"
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
  extra?: { onListFleet?: FleetLister },
): { tools: Tool[]; arsenal?: Arsenal<Tool> } {
  const allTools: Tool[] = [
    createBashTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
    createCheckpointTool(),
    createRewindTool(),
    createListDirTool(),
    createGrepTool(),
    createGlobTool(),
    createCodeSearchTool(),
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
    createGetModeTool(() => "default"),
    createAskUserQuestionTool(onAskUserQuestion),
    createAgentTool(onRunAgent),
    createTeamTool(onRunTeam),
    createParallelReviewTool(onRunTeam),
    createParallelExecuteTool(onRunTeam),
    createDebateTool(onRunTeam),
    createFleetTool(extra?.onListFleet),
    createSotaSolveTool(),
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
  if (config.skillsDir || fs.existsSync(defaultSkillsDir())) {
    tools.push(...createSkillTools(config.skillsDir ?? defaultSkillsDir()))
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

const TOOLSET_DEFS: ToolsetDefinition[] = [
  {
    name: "core",
    description: "Core file, web, search, planning, and system tools",
    toolNames: [
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "trayambak__Checkpoint",
      "trayambak__Rewind",
      "list_dir",
      "grep",
      "glob",
      "code_search",
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
      "trayambak__Debate",
      "trayambak__ParallelReview",
      "trayambak__ParallelExecute",
      "sota_solve",
      "trayambak__EnterPlanMode",
      "trayambak__NotebookEdit",
      "trayambak__GenerateAgent",
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
    toolNames: ["tool_search", "mcp__install", "trayambak__run_mcp"],
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
  const arsenal = new Arsenal<Tool>(
    {
      defaultToolsets: cfg?.defaults?.length ? cfg.defaults : DEFAULT_TOOLSETS,
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
