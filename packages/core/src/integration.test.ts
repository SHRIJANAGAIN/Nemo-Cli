/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved. */

import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry, AgentStatus, getAgentRegistry, resetAgentRegistry } from "./agent_registry.js";
import { AgentCommunicationManager, getAgentCommunicationManager } from "./agent_communication.js";
import { AgentCommunicationKind } from "./agent_communication.js";
import { ExtensionRegistry, getExtensionRegistry } from "./extension_api.js";
import { PluginManager, getPluginManager } from "./extension_api.js";
import { AnalyticsManager, getAnalyticsManager } from "./analytics.js";
import { ThreadStore, resetThreadStore, ThreadStatus, ThreadSource } from "./session_store.js";
import { tmpdir } from "os";
import { join } from "path";
import { loadProjectInstructions, discoverAgentsMdFiles, findProjectRoot } from "./agents_md.js";
import { RolloutBudget, getRolloutBudget } from "./rollout_budget.js";
import { HookRuntime, getHookRuntime, HookEventName, HookExecutionMode, HookSource } from "./hook_runtime.js";
import { CompactionReason, CompactionStrategy, CompactionPhase, CompactionTrigger, CompactionStatus, CompactionImplementation } from "./analytics.js";

describe("AgentRegistry", () => {
    beforeEach(() => resetAgentRegistry());

    it("registers an agent", () => {
        const registry = getAgentRegistry();
        const result = registry.registerAgent("thread-1", { agentRole: "coder" });
        expect(result.success).toBe(true);
        expect(result.agentId).toBeTruthy();
    });

    it("limits agents per session", () => {
        const registry = getAgentRegistry();
        registry.setMaxAgents(1);
        const result1 = registry.registerAgent("thread-1", {});
        const result2 = registry.registerAgent("thread-2", {});
        expect(result1.success).toBe(true);
        expect(result2.success).toBe(false);
    });

    it("manages agent status", () => {
        const registry = getAgentRegistry();
        const result = registry.registerAgent("thread-1", {});
        const agent = registry.getAgent(result.agentId);
        expect(agent?.status).toBeDefined();
        registry.updateStatus(result.agentId, AgentStatus.Completed);
        expect(registry.getAgent(result.agentId)?.status).toBe("completed");
    });

    it("kills all agents", () => {
        const registry = getAgentRegistry();
        registry.registerAgent("thread-1", {});
        registry.registerAgent("thread-2", {});
        registry.killAll();
        expect(registry.getActiveAgents().length).toBe(0);
    });
});

describe("AgentCommunicationManager", () => {
    beforeEach(() => getAgentCommunicationManager().clear());

    it("sends a message between agents", async () => {
        const manager = getAgentCommunicationManager();
        const result = await manager.send(AgentCommunicationKind.Message, "sender-1", "receiver-1", "hello");
        expect(result.success).toBe(true);
        expect(result.communicationId).toBeTruthy();
    });

    it("retrieves communication history", async () => {
        const manager = getAgentCommunicationManager();
        await manager.send(AgentCommunicationKind.Message, "a", "b", "test");
        const history = manager.getHistory("a", "b");
        expect(history.length).toBe(1);
    });

    it("records spawn notifications", async () => {
        const manager = getAgentCommunicationManager();
        const id = await manager.notifySpawn("main", "subagent-1");
        expect(id).toBeTruthy();
    });
});

describe("ExtensionRegistry", () => {
    beforeEach(() => getExtensionRegistry().clear());

    it("registers an extension", () => {
        const registry = getExtensionRegistry();
        registry.registerExtension({ extensionId: "ext-1", name: "Test Extension", version: "1.0.0" });
        expect(registry.hasExtension("ext-1")).toBe(true);
    });

    it("unregisters an extension", () => {
        const registry = getExtensionRegistry();
        registry.registerExtension({ extensionId: "ext-1", name: "Test", version: "1.0.0" });
        expect(registry.unregisterExtension("ext-1")).toBe(true);
        expect(registry.hasExtension("ext-1")).toBe(false);
    });

    it("returns all extensions", () => {
        const registry = getExtensionRegistry();
        registry.registerExtension({ extensionId: "ext-1", name: "Test", version: "1.0.0" });
        registry.registerExtension({ extensionId: "ext-2", name: "Test2", version: "2.0.0" });
        expect(registry.getAllExtensions().length).toBe(2);
    });
});

describe("PluginManager", () => {
    beforeEach(() => getPluginManager().clear());

    it("registers a plugin", () => {
        const manager = getPluginManager();
        manager.registerPlugin("plugin-1", "/path/to/plugin", "skill-snapshot");
        expect(manager.hasPlugin("plugin-1")).toBe(true);
    });

    it("returns skill snapshots", () => {
        const manager = getPluginManager();
        manager.registerPlugin("plugin-1", "/path/to/plugin", "snapshot");
        expect(manager.getSkillSnapshot("plugin-1")).toBe("snapshot");
    });
});

describe("AnalyticsManager", () => {
    beforeEach(() => getAnalyticsManager().clear());

    it("records compaction events", () => {
        const analytics = getAnalyticsManager();
        analytics.recordCompaction({
            reason: CompactionReason.Auto,
            strategy: CompactionStrategy.Default,
            phase: CompactionPhase.PreCompact,
            trigger: CompactionTrigger.TokenLimit,
            status: CompactionStatus.Completed,
            implementation: CompactionImplementation.Api,
            turnCount: 5,
            tokensBefore: 100000,
            tokensAfter: 50000,
            durationMs: 200,
        });
        expect(analytics.getCompactionEvents().length).toBe(1);
    });

    it("computes compaction stats", () => {
        const analytics = getAnalyticsManager();
        analytics.recordCompaction({
            reason: CompactionReason.Auto,
            strategy: CompactionStrategy.Default,
            phase: CompactionPhase.Compacting,
            trigger: CompactionTrigger.TokenLimit,
            status: CompactionStatus.Completed,
            implementation: CompactionImplementation.Api,
            turnCount: 1,
            tokensBefore: 100000,
            tokensAfter: 50000,
            durationMs: 200,
        });
        const stats = analytics.getCompactionStats();
        expect(stats.total).toBe(1);
        expect(stats.completed).toBe(1);
        expect(stats.averageTokensSaved).toBe(50000);
    });

    it("records rollout items", () => {
        const analytics = getAnalyticsManager();
        analytics.recordRollout({
            turnId: "turn-1",
            model: "gpt-4",
            inputTokens: 1000,
            outputTokens: 500,
            toolCalls: 3,
            durationMs: 5000,
        });
        const stats = analytics.getRolloutStats();
        expect(stats.totalTurns).toBe(1);
        expect(stats.totalInputTokens).toBe(1000);
    });

    it("records hook run facts", () => {
        const analytics = getAnalyticsManager();
        analytics.recordHookRun({ eventName: "pre-tool-use", durationMs: 10, status: "success", output: "allowed" });
        expect(analytics.getHookRunFacts().length).toBe(1);
    });
});

describe("ThreadStore", () => {
    let store: ThreadStore;
    beforeEach(() => {
        // Isolated per-test directory — never the real ~/.trayambak/threads.
        const dir = join(tmpdir(), `trayambak-threads-${process.pid}-${Math.random().toString(36).slice(2)}`);
        store = resetThreadStore(dir);
    });

    it("creates and reads a thread", () => {
        const thread = store.createThread("thread-1", { source: ThreadSource.User, status: ThreadStatus.Active });
        expect(thread.metadata.id).toBe("thread-1");
        const read = store.readThread("thread-1");
        expect(read).not.toBeNull();
        expect(read!.metadata.id).toBe("thread-1");
    });

    it("archives and unarchives a thread", () => {
        store.createThread("thread-1", { source: ThreadSource.User, status: ThreadStatus.Active });
        const archived = store.archiveThread("thread-1");
        expect(archived?.metadata.status).toBe("archived");
        const unarchived = store.unarchiveThread("thread-1");
        expect(unarchived?.metadata.status).toBe("active");
    });

    it("forks a thread", () => {
        const original = store.createThread("thread-1", { source: ThreadSource.User, status: ThreadStatus.Active });
        const forked = store.forkThread("thread-1", "thread-2");
        expect(forked?.metadata.forkedFrom).toBe("thread-1");
        expect(forked?.metadata.parentThreadId).toBe("thread-1");
        expect(forked?.messages.length).toBe(original.messages.length);
    });

    it("deletes a thread", () => {
        store.createThread("thread-1", { source: ThreadSource.User, status: ThreadStatus.Active });
        expect(store.getThreadCount()).toBe(1);
        store.deleteThread("thread-1");
        expect(store.getThreadCount()).toBe(0);
    });

    it("searches threads", () => {
        store.createThread("thread-1", { source: ThreadSource.User, status: ThreadStatus.Active });
        store.addMessages("thread-1", [{ role: "user", content: "hello world", timestamp: Date.now() }]);
        const results = store.searchThreads("hello");
        expect(results.length).toBe(1);
    });
});

describe("AgentsMdDiscovery", () => {
    it("finds project root", () => {
        const root = findProjectRoot("/tmp/project/.git/subdir", [".git"]);
        expect(root).toContain(".git");
    });

    it("discovers AGENTS.md files", () => {
        const files = discoverAgentsMdFiles("/tmp/project/.git", { markers: [".git"], fallbackFilenames: ["AGENTS.md"] });
        expect(Array.isArray(files)).toBe(true);
    });
});

describe("RolloutBudget", () => {
    beforeEach(() => getRolloutBudget().reset());

    it("tracks budget usage", () => {
        const budget = getRolloutBudget();
        budget.configure({ samplingTokenWeight: 1, maxBudget: 10000, reminderInterval: 1000 });
        expect(budget.isActive()).toBe(true);
        budget.recordUsage({ input_tokens: 5000, output_tokens: 2000 });
        expect(budget.getUsed()).toBeGreaterThan(0);
        expect(budget.getRemaining()).toBeLessThan(10000);
    });

    it("blocks when budget exhausted", () => {
        const budget = getRolloutBudget();
        budget.configure({ samplingTokenWeight: 1, maxBudget: 100, reminderInterval: 10 });
        budget.recordUsage({ input_tokens: 100, output_tokens: 100 });
        expect(budget.getRemaining()).toBeLessThanOrEqual(0);
    });
});

describe("HookRuntime", () => {
    beforeEach(() => getHookRuntime().clear());

    it("registers and runs hooks", async () => {
        const runtime = getHookRuntime();
        let called = false;
        runtime.register({
            name: "test-hook",
            events: [HookEventName.SessionStart],
            mode: HookExecutionMode.Blocking,
            timeoutMs: 5000,
            handler: async () => { called = true; return { shouldStop: false, additionalContext: [] }; },
        });
        const summary = await runtime.runEvent({ eventName: HookEventName.SessionStart, source: HookSource.User, cwd: "/tmp", config: {}, permissions: {} });
        expect(called).toBe(true);
        expect(summary.eventName).toBe(HookEventName.SessionStart);
    });

    it("pre-tool-use hook evaluation", async () => {
        const runtime = getHookRuntime();
        const result = await runtime.evaluatePreToolUse("bash", { command: "echo hi" }, { eventName: HookEventName.PreToolUse, source: HookSource.Model, cwd: "/tmp", config: {}, permissions: {} });
        expect(result.decision).toBe("allow");
    });
});
