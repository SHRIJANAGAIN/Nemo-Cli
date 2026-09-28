/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { join } from "path"
import { tmpdir } from "os"
import { rmSync } from "fs"
import { HookRuntime } from "./hook_runtime.js"
import { HookEventName, HookExecutionMode, HookSource } from "./hook_runtime.js"
import { getRolloutBudget } from "./rollout_budget.js"
import { getAgentRegistry, resetAgentRegistry, AgentStatus } from "./agent_registry.js"
import { getAgentCommunicationManager } from "./agent_communication.js"
import { AgentCommunicationKind } from "./agent_communication.js"
import { getExtensionRegistry } from "./extension_api.js"
import { getPluginManager } from "./extension_api.js"
import {
  getAnalyticsManager,
  CompactionReason,
  CompactionStrategy,
  CompactionPhase,
  CompactionTrigger,
  CompactionStatus,
  CompactionImplementation,
} from "./analytics.js"
import { ThreadStore, ThreadStatus, ThreadSource } from "./session_store.js"
import { loadProjectInstructions, discoverAgentsMdFiles, findProjectRoot } from "./agents_md.js"
import { ProcessManager } from "./process.js"
import { getDatabase, resetDatabase } from "./state_db.js"
import { getSafeEnv, validateEnv, createMinimalEnv } from "./env_filter.js"

// ── HookRuntime ──────────────────────────────────────────────────

describe("HookRuntime", () => {
  let runtime: HookRuntime

  beforeEach(() => {
    runtime = new HookRuntime()
  })

  it("registers a hook", () => {
    const handler = async () => ({ shouldStop: false, additionalContext: [] })
    runtime.register({
      name: "test",
      events: [HookEventName.PreToolUse],
      mode: HookExecutionMode.Blocking,
      timeoutMs: 5000,
      handler,
    })
    expect((runtime as unknown as { hooks: Map<string, unknown> }).hooks.size).toBe(1)
  })

  it("runs event and calls handler", async () => {
    let called = false
    runtime.register({
      name: "test",
      events: [HookEventName.SessionStart],
      mode: HookExecutionMode.Blocking,
      timeoutMs: 5000,
      handler: async () => {
        called = true
        return { shouldStop: false, additionalContext: [] }
      },
    })
    const summary = await runtime.runEvent({
      eventName: HookEventName.SessionStart,
      source: HookSource.User,
      cwd: "/tmp",
      config: {},
      permissions: {},
    })
    expect(called).toBe(true)
    expect(summary.exitCode).toBe(0)
  })

  it("returns early when no matching hooks", async () => {
    const summary = await runtime.runEvent({
      eventName: HookEventName.PreToolUse,
      source: HookSource.Model,
      cwd: "/tmp",
      config: {},
      permissions: {},
    })
    expect(summary.exitCode).toBe(0)
  })

  it("evaluatePreToolUse returns allow by default", async () => {
    const result = await runtime.evaluatePreToolUse(
      "bash",
      { command: "echo hi" },
      {
        eventName: HookEventName.PreToolUse,
        source: HookSource.Model,
        cwd: "/tmp",
        config: {},
        permissions: {},
      },
    )
    expect(result.decision).toBe("allow")
  })

  it("blocks when hook sets shouldStop", async () => {
    runtime.register({
      name: "blocker",
      events: [HookEventName.PreToolUse],
      mode: HookExecutionMode.Blocking,
      timeoutMs: 5000,
      handler: async () => ({ shouldStop: true, additionalContext: ["blocked"] }),
    })
    const result = await runtime.evaluatePreToolUse(
      "bash",
      { command: "rm -rf /" },
      {
        eventName: HookEventName.PreToolUse,
        source: HookSource.Model,
        cwd: "/tmp",
        config: {},
        permissions: {},
      },
    )
    expect(result.decision).toBe("deny")
  })

  it("clears all hooks", () => {
    runtime.register({
      name: "test",
      events: [HookEventName.SessionStart],
      mode: HookExecutionMode.Blocking,
      timeoutMs: 5000,
      handler: async () => ({ shouldStop: false, additionalContext: [] }),
    })
    runtime.clear()
    expect((runtime as unknown as { hooks: Map<string, unknown> }).hooks.size).toBe(0)
  })

  it("handles timeout by returning timed-out result", async () => {
    runtime.register({
      name: "slow",
      events: [HookEventName.SessionStart],
      mode: HookExecutionMode.Blocking,
      timeoutMs: 1,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 100))
        return { shouldStop: false, additionalContext: [] }
      },
    })
    const summary = await runtime.runEvent({
      eventName: HookEventName.SessionStart,
      source: HookSource.User,
      cwd: "/tmp",
      config: {},
      permissions: {},
    })
    expect(summary.exitCode).toBe(0)
  })
})

// ── RolloutBudget ────────────────────────────────────────────────

describe("RolloutBudget", () => {
  beforeEach(() => {
    getRolloutBudget().reset()
  })

  it("starts active after configure", () => {
    const budget = getRolloutBudget()
    budget.configure({ maxBudget: 10000, samplingTokenWeight: 1, reminderInterval: 1000 })
    expect(budget.isActive()).toBe(true)
  })

  it("records usage and decrements remaining", () => {
    const budget = getRolloutBudget()
    budget.configure({ maxBudget: 10000, samplingTokenWeight: 1, reminderInterval: 1000 })
    budget.recordUsage({ input_tokens: 5000, output_tokens: 2000 })
    expect(budget.getRemaining()).toBeLessThan(10000)
    expect(budget.getUsed()).toBeGreaterThan(0)
  })

  it("blocks when budget is exhausted", () => {
    const budget = getRolloutBudget()
    budget.configure({ maxBudget: 100, samplingTokenWeight: 1, reminderInterval: 10 })
    budget.recordUsage({ input_tokens: 100, output_tokens: 100 })
    expect(budget.getRemaining()).toBeLessThanOrEqual(0)
  })

  it("reset clears state so budget is inactive", () => {
    const budget = getRolloutBudget()
    budget.configure({ maxBudget: 100, samplingTokenWeight: 1, reminderInterval: 10 })
    budget.recordUsage({ input_tokens: 100, output_tokens: 100 })
    budget.reset()
    expect(budget.isActive()).toBe(false)
  })
})

// ── AgentRegistry ────────────────────────────────────────────────

describe("AgentRegistry", () => {
  beforeEach(() => resetAgentRegistry())

  it("registers an agent with default limit", () => {
    const registry = getAgentRegistry()
    const result = registry.registerAgent("thread-1", { agentRole: "coder" })
    expect(result.success).toBe(true)
    expect(result.agentId).toBeTruthy()
  })

  it("enforces max agents limit", () => {
    const registry = getAgentRegistry()
    registry.setMaxAgents(1)
    registry.registerAgent("thread-1", {})
    const result2 = registry.registerAgent("thread-2", {})
    expect(result2.success).toBe(false)
  })

  it("updates agent status", () => {
    const registry = getAgentRegistry()
    const result = registry.registerAgent("thread-1", {})
    registry.updateStatus(result.agentId, AgentStatus.Completed)
    expect(registry.getAgent(result.agentId)?.status).toBe("completed")
  })

  it("removes an agent", () => {
    const registry = getAgentRegistry()
    const result = registry.registerAgent("thread-1", {})
    registry.removeAgent(result.agentId)
    expect(registry.getAgent(result.agentId)).toBeUndefined()
  })

  it("kills all agents", () => {
    const registry = getAgentRegistry()
    registry.registerAgent("thread-1", {})
    registry.registerAgent("thread-2", {})
    registry.killAll()
    expect(registry.getActiveAgents().length).toBe(0)
  })

  it("assigns unique nicknames", () => {
    const registry = getAgentRegistry()
    const r1 = registry.registerAgent("thread-1", { agentNickname: "helper" })
    const r2 = registry.registerAgent("thread-2", { agentNickname: "helper" })
    expect(r2.agentId).not.toBe(r1.agentId)
  })

  it("resets the registry", () => {
    const registry = getAgentRegistry()
    registry.registerAgent("thread-1", {})
    resetAgentRegistry()
    expect(registry.getActiveAgents().length).toBe(0)
  })
})

// ── AgentCommunicationManager ──────────────────────────────────

describe("AgentCommunicationManager", () => {
  beforeEach(() => getAgentCommunicationManager().clear())

  it("sends a message", async () => {
    const mgr = getAgentCommunicationManager()
    const result = await mgr.send(AgentCommunicationKind.Message, "a", "b", "hello")
    expect(result.success).toBe(true)
  })

  it("retrieves history", async () => {
    const mgr = getAgentCommunicationManager()
    await mgr.send(AgentCommunicationKind.Message, "a", "b", "test")
    expect(mgr.getHistory("a", "b").length).toBe(1)
  })

  it("notifies spawn", async () => {
    const mgr = getAgentCommunicationManager()
    const id = await mgr.notifySpawn("main", "sub-1")
    expect(id).toBeTruthy()
  })

  it("sends result", async () => {
    const mgr = getAgentCommunicationManager()
    const id = await mgr.sendResult("agent-1", "done")
    expect(id).toBeTruthy()
  })

  it("clears all communications", async () => {
    const mgr = getAgentCommunicationManager()
    await mgr.send(AgentCommunicationKind.Message, "a", "b", "test")
    mgr.clear()
    expect(mgr.getHistory("a", "b").length).toBe(0)
  })
})

// ── ExtensionRegistry ──────────────────────────────────────────

describe("ExtensionRegistry", () => {
  beforeEach(() => getExtensionRegistry().clear())

  it("registers an extension", () => {
    const reg = getExtensionRegistry()
    reg.registerExtension({ extensionId: "ext-1", name: "Test", version: "1.0.0" })
    expect(reg.hasExtension("ext-1")).toBe(true)
  })

  it("unregisters an extension", () => {
    const reg = getExtensionRegistry()
    reg.registerExtension({ extensionId: "ext-1", name: "Test", version: "1.0.0" })
    expect(reg.unregisterExtension("ext-1")).toBe(true)
    expect(reg.hasExtension("ext-1")).toBe(false)
  })

  it("manages MCP servers", () => {
    const reg = getExtensionRegistry()
    reg.registerExtension({ extensionId: "ext-1", name: "Test", version: "1.0.0" }, [
      { name: "server1", command: ["node"], capabilities: ["tools"] },
    ])
    expect(reg.getMcpServers("server1").length).toBe(1)
  })

  it("returns all tools", () => {
    const reg = getExtensionRegistry()
    reg.registerExtension({ extensionId: "ext-1", name: "Test", version: "1.0.0" }, [], ["tool1", "tool2"])
    expect(reg.getAllTools().length).toBe(2)
  })
})

// ── PluginManager ──────────────────────────────────────────────

describe("PluginManager", () => {
  beforeEach(() => getPluginManager().clear())

  it("registers a plugin", () => {
    const mgr = getPluginManager()
    mgr.registerPlugin("p1", "/path", "snapshot")
    expect(mgr.hasPlugin("p1")).toBe(true)
  })

  it("returns skill snapshot", () => {
    const mgr = getPluginManager()
    mgr.registerPlugin("p1", "/path", "snapshot")
    expect(mgr.getSkillSnapshot("p1")).toBe("snapshot")
  })
})

// ── AnalyticsManager ──────────────────────────────────────────

describe("AnalyticsManager", () => {
  beforeEach(() => getAnalyticsManager().clear())

  it("records compaction", () => {
    const a = getAnalyticsManager()
    a.recordCompaction({
      reason: CompactionReason.Auto,
      strategy: CompactionStrategy.Default,
      phase: CompactionPhase.PreCompact,
      trigger: CompactionTrigger.TokenLimit,
      status: CompactionStatus.Completed,
      implementation: CompactionImplementation.Api,
      turnCount: 1,
      tokensBefore: 1000,
      tokensAfter: 500,
      durationMs: 200,
    })
    expect(a.getCompactionEvents().length).toBe(1)
  })

  it("computes stats", () => {
    const a = getAnalyticsManager()
    a.recordCompaction({
      reason: CompactionReason.Auto,
      strategy: CompactionStrategy.Default,
      phase: CompactionPhase.Compacting,
      trigger: CompactionTrigger.TokenLimit,
      status: CompactionStatus.Completed,
      implementation: CompactionImplementation.Api,
      turnCount: 1,
      tokensBefore: 1000,
      tokensAfter: 500,
      durationMs: 200,
    })
    const s = a.getCompactionStats()
    expect(s.total).toBe(1)
    expect(s.averageTokensSaved).toBe(500)
  })

  it("records rollout", () => {
    const a = getAnalyticsManager()
    a.recordRollout({
      turnId: "t1",
      model: "m1",
      inputTokens: 100,
      outputTokens: 50,
      toolCalls: 2,
      durationMs: 1000,
    })
    expect(a.getRolloutItems().length).toBe(1)
  })

  it("records hook run", () => {
    const a = getAnalyticsManager()
    a.recordHookRun({ eventName: "test", durationMs: 10, status: "success", output: "ok" })
    expect(a.getHookRunFacts().length).toBe(1)
  })

  it("records generic events", () => {
    const a = getAnalyticsManager()
    a.recordEvent("turn_start", {})
    expect(a.getEventsByType("turn_start").length).toBe(1)
  })
})

// ── ThreadStore ────────────────────────────────────────────────

describe("ThreadStore", () => {
  let store: ThreadStore
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ts-${Date.now()}`)
    store = ThreadStore.getInstance(tmpDir)
    store.clear()
  })

  afterEach(() => {
    store.clear()
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it("creates and reads thread", () => {
    store.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    const t = store.readThread("t1")
    expect(t).not.toBeNull()
    expect(t!.metadata.id).toBe("t1")
  })

  it("archives and unarchives", () => {
    store.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    store.archiveThread("t1")
    expect(store.readThread("t1")?.metadata.status).toBe("archived")
    store.unarchiveThread("t1")
    expect(store.readThread("t1")?.metadata.status).toBe("active")
  })

  it("forks a thread", () => {
    store.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    const forked = store.forkThread("t1", "t2")
    expect(forked?.metadata.forkedFrom).toBe("t1")
  })

  it("deletes a thread", () => {
    store.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    expect(store.getThreadCount()).toBe(1)
    store.deleteThread("t1")
    expect(store.getThreadCount()).toBe(0)
  })

  it("adds messages", () => {
    store.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    store.addMessages("t1", [{ role: "user", content: "hi", timestamp: Date.now() }])
    const t = store.readThread("t1")
    expect(t?.messages.length).toBe(1)
  })

  it("migrates a thread", () => {
    store.createThread("t1", { source: ThreadSource.User, status: ThreadStatus.Active })
    const newDir = join(tmpDir, "new")
    expect(store.migrateThread("t1", newDir)).toBe(true)
  })
})

// ── AgentsMd Discovery ─────────────────────────────────────────

describe("AgentsMdDiscovery", () => {
  it("finds project root", () => {
    const root = findProjectRoot("/a/b/c/.git/d", [".git"])
    expect(root).toContain(".git")
  })

  it("returns cwd when no root marker", () => {
    const root = findProjectRoot("/tmp/no-git-here", [".git"])
    expect(root).toBe("/tmp/no-git-here")
  })

  it("discovers AGENTS.md files", () => {
    const files = discoverAgentsMdFiles("/tmp", { markers: [], fallbackFilenames: ["AGENTS.md"] })
    expect(Array.isArray(files)).toBe(true)
  })

  it("loadProjectInstructions returns null when no files", () => {
    const result = loadProjectInstructions("/tmp/no-agents-md", { markers: [], fallbackFilenames: ["NONEXISTENT.md"] })
    expect(result).toBeNull()
  })
})

// ── ProcessManager ─────────────────────────────────────────────

describe("ProcessManager", () => {
  it("has killProcessGroup method", () => {
    const pm = new ProcessManager()
    expect(typeof pm.killProcessGroup).toBe("function")
  })
})

// ── StateDB ──────────────────────────────────────────────────

describe("StateDB", () => {
  beforeEach(() => resetDatabase())

  it("getDatabase returns a DatabaseDatabase", () => {
    const db = getDatabase()
    expect(db).toBeDefined()
    expect(typeof db.saveThread).toBe("function")
  })
})

// ── EnvFilter ──────────────────────────────────────────────

describe("EnvFilter", () => {
  it("filters allowed env vars", () => {
    const result = getSafeEnv({ PATH: "/usr/bin", HOME: "/home/user", SECRET: "hidden" }, "policy-only")
    expect(result.PATH).toBe("/usr/bin")
    expect(result.HOME).toBe("/home/user")
    expect(result.SECRET).toBeUndefined()
  })

  it("validateEnv returns blocked list", () => {
    const blocked = validateEnv({ API_KEY: "secret123", PATH: "/usr/bin" })
    expect(blocked.includes("API_KEY")).toBe(true)
  })

  it("creates minimal env", () => {
    const env = createMinimalEnv()
    expect(env.PATH).toBeDefined()
    expect(env.HOME).toBeDefined()
    expect(env.CODEX_SANDBOX).toBe("policy-only")
  })
})
