/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Core module index — updated with all new modules.
 */

export * from "./toolsets/arsenal.js"
export * from "./context/compactor.js"
export * from "./memory/provider.js"
export * from "./memory/manager.js"
export * from "./cron/scheduler.js"
export * from "./curator/librarian.js"
export * from "./providers/registry.js"
export * from "./providers/manager.js"
export * from "./process.js"
/* Tracing: the repo had no tracing at all — the observability package it used to
 * call was a no-op stand-in. traceparent is emitted in the W3C form so these
 * traces stitch to any OTLP-compatible collector without a protobuf dependency. */
export * from "./tracing.js"
/* Memory decay: TTL expiry, concept-gated contradiction detection by Jaccard
 * similarity, and newest-wins supersession. Extracted from agentmemory; pure, so
 * the policy is testable without a store. Superseded memories are KEPT so the
 * decision stays reversible. */
export * from "./memory_decay.js"
/* Git-scoped memory: branch/worktree detection and provenance, plus checkpoints as
 * an explicit state machine. The scope key is repoRoot#branch, NOT the worktree
 * path, so a memory recorded in a linked worktree stays valid at the same
 * branch in the main checkout. */
export * from "./git_scope.js"
/* Relations between memories: typed edges, dependency-cycle detection reported as a
 * PATH, transitive supersedes closure, and blocked-work propagation to a fixed
 * point. All pure and iterative, so a deep dependency chain cannot overflow. */
export * from "./relations.js"
/* Credential storage: Windows chmod 0600 leaves the inherited ACL in place, which
 * leaves the API key readable by several principals including a sandbox user
 * group. The ACL is stripped here, and the OS keychain is used where one exists. */
export * from "./credential_store.js"
export * from "./state_db.js"
export * from "./env_filter.js"
export * from "./hook_runtime.js"
export * from "./rollout_budget.js"
export * from "./agent_registry.js"
export * from "./agent_communication.js"
export * from "./agents_md.js"
export * from "./extension_api.js"
export * from "./session_store.js"
export * from "./analytics.js"
export * from "./feature_flags.js"
export * from "./approval.js"
export * from "./plan_mode.js"
export * from "./subagents.js"
export * from "./token_budget.js"
/* The recursive harness: the system around the model (system prompt,
 * guardrails, memory, tool guidance, skills, subagents, scripts, plugins)
 * as something the agent can refine on its own. Model-agnostic by design —
 * every model call goes through ports, so the shape is testable without a
 * provider. */
export * from "./harness/index.js"
