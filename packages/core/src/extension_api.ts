/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Portions derived from OpenAI Codex CLI (codex-rs), Copyright 2025 OpenAI,
 * licensed under the Apache License, Version 2.0. See THIRD_PARTY_NOTICES.md.
 */

/**
 * Extension API — plugin system with MCP server contributions.
 *
 * Mirrors codex-rs/core/src/plugins and codex-rs/core/src/extension_api
 * in Rust.
 * Provides a full plugin/extension system for adding tools, MCP servers,
 * and custom capabilities to the agent.
 */

/** Extension data — metadata about a plugin/extension. */
export interface ExtensionData {
  id: string
  name: string
  version: string
  description?: string
  contributors: string[]
}

/** MCP server contribution from an extension. */
export interface McpServerContribution {
  name: string
  command: string[]
  env?: Record<string, string>
  timeoutMs?: number
  capabilities: string[]
}

/** Extension data initialization. */
export interface ExtensionDataInit {
  extensionId: string
  name: string
  version: string
  description?: string
}

/** Registry entry for a registered extension. */
export interface RegistryEntry {
  extension: ExtensionData
  mcpServers: McpServerContribution[]
  tools: string[]
  registeredAt: number
}

/**
 * Extension Registry — manages all plugins and extensions.
 *
 * Mirrors codex-rs/core/src/extension_api::ExtensionRegistry.
 * Supports:
 * - Registering/unregistering extensions
 * - MCP server contributions from extensions
 * - Tool discovery and registration
 * - Extension lifecycle management
 */
export class ExtensionRegistry {
  private static instance: ExtensionRegistry | null = null
  private extensions: Map<string, RegistryEntry> = new Map()
  private mcpServers: Map<string, McpServerContribution[]> = new Map()

  private constructor() {}

  /** Get the singleton ExtensionRegistry instance. */
  static getInstance(): ExtensionRegistry {
    if (!ExtensionRegistry.instance) {
      ExtensionRegistry.instance = new ExtensionRegistry()
    }
    return ExtensionRegistry.instance
  }

  /**
   * Register an extension with its MCP servers and tools.
   */
  registerExtension(data: ExtensionDataInit, mcpServers: McpServerContribution[] = [], tools: string[] = []): void {
    const entry: RegistryEntry = {
      extension: {
        id: data.extensionId,
        name: data.name,
        version: data.version,
        description: data.description,
        contributors: [],
      },
      mcpServers,
      tools,
      registeredAt: Date.now(),
    }

    this.extensions.set(data.extensionId, entry)

    // Register MCP servers from this extension
    for (const server of mcpServers) {
      const existing = this.mcpServers.get(server.name) ?? []
      existing.push(server)
      this.mcpServers.set(server.name, existing)
    }
  }

  /**
   * Unregister an extension by ID.
   */
  unregisterExtension(extensionId: string): boolean {
    const entry = this.extensions.get(extensionId)
    if (!entry) return false

    // Remove MCP servers associated with this extension
    for (const server of entry.mcpServers) {
      const existing = this.mcpServers.get(server.name)
      if (existing) {
        const filtered = existing.filter((s) => s !== server)
        if (filtered.length === 0) {
          this.mcpServers.delete(server.name)
        } else {
          this.mcpServers.set(server.name, filtered)
        }
      }
    }

    return this.extensions.delete(extensionId)
  }

  /**
   * Get an extension by ID.
   */
  getExtension(extensionId: string): RegistryEntry | undefined {
    return this.extensions.get(extensionId)
  }

  /**
   * Get all registered extensions.
   */
  getAllExtensions(): RegistryEntry[] {
    return Array.from(this.extensions.values())
  }

  /**
   * Get all MCP server contributions across all extensions.
   */
  getAllMcpServers(): Map<string, McpServerContribution[]> {
    return new Map(this.mcpServers)
  }

  /**
   * Get MCP servers by name.
   */
  getMcpServers(name: string): McpServerContribution[] {
    return this.mcpServers.get(name) ?? []
  }

  /**
   * Get all registered tool names.
   */
  getAllTools(): string[] {
    const tools = new Set<string>()
    for (const entry of this.extensions.values()) {
      for (const tool of entry.tools) {
        tools.add(tool)
      }
    }
    return Array.from(tools)
  }

  /**
   * Check if an extension is registered.
   */
  hasExtension(extensionId: string): boolean {
    return this.extensions.has(extensionId)
  }

  /**
   * Get extension count.
   */
  getExtensionCount(): number {
    return this.extensions.size
  }

  /**
   * Clear all extensions (useful for testing).
   */
  clear(): void {
    this.extensions.clear()
    this.mcpServers.clear()
  }
}

/** Get the singleton ExtensionRegistry. */
export function getExtensionRegistry(): ExtensionRegistry {
  return ExtensionRegistry.getInstance()
}

/**
 * Plugin Manager — discovers, loads, and manages plugins.
 *
 * Mirrors codex-rs/core/src/plugins::PluginsManager.
 * Supports discoverable plugins, skill snapshots, and mentions.
 */
export class PluginManager {
  private static instance: PluginManager | null = null
  private plugins: Map<string, PluginEntry> = new Map()
  private skillSnapshots: Map<string, string> = new Map()

  private constructor() {}

  /** Get the singleton PluginManager instance. */
  static getInstance(): PluginManager {
    if (!PluginManager.instance) {
      PluginManager.instance = new PluginManager()
    }
    return PluginManager.instance
  }

  /**
   * Register a plugin with its skill snapshot.
   */
  registerPlugin(name: string, path: string, skillSnapshot?: string): void {
    const entry: PluginEntry = {
      name,
      path,
      skillSnapshot,
      registeredAt: Date.now(),
    }
    this.plugins.set(name, entry)

    if (skillSnapshot) {
      this.skillSnapshots.set(name, skillSnapshot)
    }
  }

  /**
   * Get a plugin by name.
   */
  getPlugin(name: string): PluginEntry | undefined {
    return this.plugins.get(name)
  }

  /**
   * Get all registered plugins.
   */
  getAllPlugins(): PluginEntry[] {
    return Array.from(this.plugins.values())
  }

  /**
   * Get a skill snapshot for a plugin.
   */
  getSkillSnapshot(pluginName: string): string | undefined {
    return this.skillSnapshots.get(pluginName)
  }

  /**
   * Check if a plugin is registered.
   */
  hasPlugin(name: string): boolean {
    return this.plugins.has(name)
  }

  /**
   * Clear all plugins (useful for testing).
   */
  clear(): void {
    this.plugins.clear()
    this.skillSnapshots.clear()
  }
}

interface PluginEntry {
  name: string
  path: string
  skillSnapshot?: string
  registeredAt: number
}

/** Get the singleton PluginManager. */
export function getPluginManager(): PluginManager {
  return PluginManager.getInstance()
}

/**
 * Discover plugins from a directory.
 */
export function discoverPlugins(_pluginDir: string): string[] {
  // This would scan a directory for plugin manifest files
  // For now, return an empty array as the base implementation
  return []
}
