/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

export * from "../../../packages/protocol/src/index.js"
export * from "./config.js"
export * from "./checkpoints.js"
export * from "./compaction.js"
export {
  checkForUpdate,
  getReleaseType,
  detectMethod,
  findInstallRoot,
  getInstalledVersion,
  fetchLatestNpmVersion,
  fetchLatestGitVersion,
  parseMaxTagVersion,
} from "./update/auto-update.js"
export type { UpdateOutcome, UpdateMethod, ReleaseType } from "./update/auto-update.js"
export * from "./prompt/power-prompt.js"
export * from "./session/session.js"
export * from "./tools/index.js"
export * from "./developer-mode/index.js"
export * from "./artifacts/index.js"
export { Agent } from "./agent/agent.js"
export type { AgentOptions, SubagentRunTask, SubagentResult, BackgroundSubagentInfo } from "./agent/agent.js"
export { runAgentLoop } from "./agent/agent-loop.js"
export type { RunConfig } from "./agent/agent-loop.js"
export {
  discoverAgentProfiles,
  getAgentProfile,
  findReviewersForFiles,
  findBuildResolversForLanguage,
} from "./agent/specialist-agents.js"
export type { AgentProfile, AgentCategory } from "./agent/specialist-agents.js"
export { detectWorkspaceState } from "./agent/auto-pilot.js"
export type { AutonomousActionPlan } from "./agent/auto-pilot.js"
export { ensureLlamaCppBin, locateLlamaCppBin } from "./llama-cpp-bin.js"
export { createMcpConnection } from "../../../packages/mcp/src/index.js"
export { HarnessRuntime, RecursiveTaskRuntime } from "../../../packages/harness/src/index.js"
export type { HarnessEvent, HarnessPlugin, HarnessState, RecursiveTask } from "../../../packages/harness/src/index.js"

export { SotaReasoningEngine, TaskAnalyzer, BudgetAllocator, SearchNode } from "./agent/sota.js"
export type {
  Difficulty,
  Budget,
  VerificationResult,
  ExecutionResult,
  ScoredCandidate,
  SotaOptions,
  SotaEvent,
} from "./agent/sota.js"
