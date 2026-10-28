/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import path from "path"
import * as fs from "fs"
import * as os from "os"

import type { McpServerSpec } from "../../../../../packages/mcp/src/index.js"

/**
 * A discoverable MCP server in the connector registry.
 * Mirrors the connector concept from the reference agent projects.
 */
export interface ConnectorEntry {
  /** Unique connector ID, e.g. "slack" or "github" */
  id: string
  /** Human-readable name */
  name: string
  /** Short description shown in connection prompts */
  description: string
  /** Keywords for searching the registry */
  keywords: string[]
  /** The MCP server spec to use when connecting */
  spec: McpServerSpec
  /** Optional npm package to install before connecting */
  npmPackage?: string
  /** Optional category e.g. "communication", "productivity", "development" */
  category?: string
}

/** Built-in connector registry — curated list of common MCP servers. */
const BUILTIN_CONNECTORS: ConnectorEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "GitHub API integration: repos, issues, PRs, commits",
    keywords: ["github", "git", "repo", "repository", "issue", "pr", "pull request", "commit"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-github"] },
    npmPackage: "@modelcontextprotocol/server-github",
    category: "development",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read and send messages, manage channels in Slack",
    keywords: ["slack", "chat", "message", "channel", "team"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-slack"] },
    npmPackage: "@modelcontextprotocol/server-slack",
    category: "communication",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Read, create, and manage Google Drive files",
    keywords: ["google drive", "gdrive", "drive", "google", "files", "docs", "sheets"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-gdrive"] },
    npmPackage: "@modelcontextprotocol/server-gdrive",
    category: "productivity",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "List, create, and manage Google Calendar events",
    keywords: ["google calendar", "calendar", "gcal", "schedule", "event", "meeting"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-gcal"] },
    npmPackage: "@modelcontextprotocol/server-gcal",
    category: "productivity",
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Read, search, and send Gmail messages",
    keywords: ["gmail", "email", "mail", "message", "inbox"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-gmail"] },
    npmPackage: "@modelcontextprotocol/server-gmail",
    category: "communication",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read, write, and search files on the local filesystem",
    keywords: ["filesystem", "files", "local", "read", "write", "search", "file system"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", os.homedir()] },
    npmPackage: "@modelcontextprotocol/server-filesystem",
    category: "filesystem",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Query PostgreSQL databases",
    keywords: ["postgres", "postgresql", "sql", "database", "db", "psql", "query"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost:5432"] },
    npmPackage: "@modelcontextprotocol/server-postgres",
    category: "database",
  },
  {
    id: "sqlite",
    name: "SQLite",
    description: "Query SQLite databases",
    keywords: ["sqlite", "sql", "database", "db", "sqlite3", "query"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-sqlite", "sqlite::memory:"] },
    npmPackage: "@modelcontextprotocol/server-sqlite",
    category: "database",
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via Brave Search API",
    keywords: ["brave", "search", "web", "internet", "google"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-brave-search"] },
    npmPackage: "@modelcontextprotocol/server-brave-search",
    category: "search",
  },
  {
    id: "weather",
    name: "Weather",
    description: "Weather forecasts and conditions",
    keywords: ["weather", "forecast", "climate", "temperature", "rain"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-weather"] },
    npmPackage: "@modelcontextprotocol/server-weather",
    category: "utilities",
  },
  {
    id: "time",
    name: "Time",
    description: "World time, timezones, and date utilities",
    keywords: ["time", "timezone", "date", "clock", "world time"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-time"] },
    npmPackage: "@modelcontextprotocol/server-time",
    category: "utilities",
  },
  {
    id: "git",
    name: "Git",
    description: "Git repository operations: log, diff, blame, status",
    keywords: ["git", "version control", "commit", "diff", "blame", "log", "status"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-git"] },
    npmPackage: "@modelcontextprotocol/server-git",
    category: "development",
  },
  {
    id: "docker",
    name: "Docker",
    description: "Manage Docker containers, images, and volumes",
    keywords: ["docker", "container", "image", "volume", "compose"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-docker"] },
    npmPackage: "@modelcontextprotocol/server-docker",
    category: "devops",
  },
  {
    id: "kubernetes",
    name: "Kubernetes",
    description: "Query Kubernetes cluster resources",
    keywords: ["kubernetes", "k8s", "cluster", "pod", "deployment", "service"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-kubernetes"] },
    npmPackage: "@modelcontextprotocol/server-kubernetes",
    category: "devops",
  },
  {
    id: "redis",
    name: "Redis",
    description: "Query and manage Redis databases",
    keywords: ["redis", "cache", "key-value", "kv", "database"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-redis"] },
    npmPackage: "@modelcontextprotocol/server-redis",
    category: "database",
  },
  {
    id: "mongodb",
    name: "MongoDB",
    description: "Query MongoDB collections",
    keywords: ["mongodb", "mongo", "database", "collection", "document", "nosql"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-mongodb"] },
    npmPackage: "@modelcontextprotocol/server-mongodb",
    category: "database",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Read and create Notion pages, databases, and blocks",
    keywords: ["notion", "notes", "wiki", "docs", "database", "page"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-notion"] },
    npmPackage: "@modelcontextprotocol/server-notion",
    category: "productivity",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Manage Linear issues, projects, and teams",
    keywords: ["linear", "issue", "ticket", "project", "team", "bug"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-linear"] },
    npmPackage: "@modelcontextprotocol/server-linear",
    category: "productivity",
  },
  {
    id: "jira",
    name: "Jira",
    description: "Query Jira issues and projects",
    keywords: ["jira", "issue", "ticket", "atlassian", "project", "bug"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-jira"] },
    npmPackage: "@modelcontextprotocol/server-jira",
    category: "productivity",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Query Stripe payments, customers, and invoices",
    keywords: ["stripe", "payment", "billing", "customer", "invoice", "subscription"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-stripe"] },
    npmPackage: "@modelcontextprotocol/server-stripe",
    category: "business",
  },
  {
    id: "figma",
    name: "Figma",
    description: "Read Figma files, components, and design tokens",
    keywords: ["figma", "design", "ui", "component", "token", "fig", "figma file"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-figma"] },
    npmPackage: "@modelcontextprotocol/server-figma",
    category: "design",
  },
  {
    id: "github-alerts",
    name: "GitHub Alerts",
    description: "Query GitHub security alerts and vulnerabilities",
    keywords: ["github alerts", "security", "vulnerability", "alert", "cve"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-github-alerts"] },
    npmPackage: "@modelcontextprotocol/server-github-alerts",
    category: "security",
  },
  {
    id: "semgrep",
    name: "Semgrep",
    description: "Run Semgrep security scanning on code",
    keywords: ["semgrep", "security", "sast", "scan", "vulnerability", "code"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-semgrep"] },
    npmPackage: "@modelcontextprotocol/server-semgrep",
    category: "security",
  },
  {
    id: "kubernetes-read-only",
    name: "Kubernetes (Read-Only)",
    description: "Read-only access to Kubernetes cluster resources",
    keywords: ["kubernetes", "k8s", "cluster", "pod", "deployment", "read-only"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-kubernetes-read-only"] },
    npmPackage: "@modelcontextprotocol/server-kubernetes-read-only",
    category: "devops",
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Structured thinking tool for complex reasoning",
    keywords: ["thinking", "reasoning", "sequential", "planning", "analysis"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"] },
    npmPackage: "@modelcontextprotocol/server-sequential-thinking",
    category: "utilities",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Browser automation via Puppeteer - navigate pages, click, screenshot",
    keywords: ["puppeteer", "browser", "chrome", "web", "automation", "screenshot", "scrape"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-puppeteer"] },
    npmPackage: "@modelcontextprotocol/server-puppeteer",
    category: "browser",
  },
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Read and manage Obsidian vault notes",
    keywords: ["obsidian", "notes", "vault", "markdown", "second brain"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-obsidian"] },
    npmPackage: "@modelcontextprotocol/server-obsidian",
    category: "productivity",
  },
  {
    id: "airbnb",
    name: "Airbnb",
    description: "Search Airbnb listings",
    keywords: ["airbnb", "travel", "listing", "accommodation", "hotel", "rental"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-airbnb"] },
    npmPackage: "@modelcontextprotocol/server-airbnb",
    category: "travel",
  },
  {
    id: "exa",
    name: "Exa",
    description: "Web search and content extraction via Exa AI",
    keywords: ["exa", "search", "web", "research", "extract"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-exa"] },
    npmPackage: "@modelcontextprotocol/server-exa",
    category: "search",
  },
  {
    id: "tettra",
    name: "Tettra",
    description: "Read Tettra knowledge base articles",
    keywords: ["tettra", "wiki", "knowledge", "docs", "knowledge base"],
    spec: { command: ["npx", "-y", "@modelcontextprotocol/server-tettra"] },
    npmPackage: "@modelcontextprotocol/server-tettra",
    category: "productivity",
  },
  {
    id: "nemo-git",
    name: "Nemo Git",
    description: "Git repository operations: status, log, branches, commit, diff, analysis (Python MCP)",
    keywords: ["git", "nemo", "version control", "commit", "diff", "blame", "log", "status"],
    spec: {
      command: ["python", path.join(__dirname, "..", "..", "..", "..", "servers", "git-server", "server.py")],
      cwd: path.join(__dirname, "..", "..", "..", "..", "servers", "git-server"),
    },
    npmPackage: "mcp",
    category: "development",
  },
  {
    id: "nemo-filesystem",
    name: "Nemo Filesystem",
    description: "Safe filesystem operations: read, write, list, delete, copy, file info with sandbox (Python MCP)",
    keywords: ["filesystem", "files", "local", "read", "write", "search", "file system", "nemo"],
    spec: {
      command: ["python", path.join(__dirname, "..", "..", "..", "..", "servers", "file-system-server", "server.py")],
      cwd: path.join(__dirname, "..", "..", "..", "..", "servers", "file-system-server"),
    },
    npmPackage: "mcp",
    category: "filesystem",
  },
  {
    id: "nemo-database",
    name: "Nemo Database",
    description: "SQL database operations: execute queries, create tables, analyze, table info (Python MCP)",
    keywords: ["database", "sql", "sqlite", "query", "nemo"],
    spec: {
      command: ["python", path.join(__dirname, "..", "..", "..", "..", "servers", "database-server", "server.py")],
      cwd: path.join(__dirname, "..", "..", "..", "..", "servers", "database-server"),
    },
    npmPackage: "mcp",
    category: "database",
  },
  {
    id: "nemo-web",
    name: "Nemo Web",
    description: "Web scraping and data extraction: parse HTML, metadata, validate URLs, extract JSON (Python MCP)",
    keywords: ["web", "scrape", "html", "metadata", "url", "json", "nemo"],
    spec: {
      command: ["python", path.join(__dirname, "..", "..", "..", "..", "servers", "web-server", "server.py")],
      cwd: path.join(__dirname, "..", "..", "..", "..", "servers", "web-server"),
    },
    npmPackage: "mcp",
    category: "web",
  },
  {
    id: "nemo-env",
    name: "Nemo Env",
    description:
      "Environment variable management: get/set env, load .env, list variables, validate config (Python MCP)",
    keywords: ["env", "environment", "config", "variables", "nemo"],
    spec: {
      command: ["python", path.join(__dirname, "..", "..", "..", "..", "servers", "env-server", "server.py")],
      cwd: path.join(__dirname, "..", "..", "..", "..", "servers", "env-server"),
    },
    npmPackage: "mcp",
    category: "utilities",
  },
]

/**
 * Spellings a query token could plausibly stand for.
 *
 * Models search with prose ("serve", "execution", "scraping"), the catalog
 * uses catalogue words ("server", "execute", "scrape"). Without this bridge a
 * perfectly good server is unreachable by its own description.
 */
function tokenVariants(token: string): string[] {
  const out = new Set<string>([token])
  if (token.endsWith("ing") && token.length > 5) out.add(token.slice(0, -3))
  if (token.endsWith("er") && token.length > 4) out.add(token.slice(0, -2))
  if (token.endsWith("s") && token.length > 3) out.add(token.slice(0, -1))
  if (token.endsWith("e") && token.length > 4) out.add(token.slice(0, -1))
  if (token.length >= 6) out.add(token.slice(0, 5))
  return [...out]
}

/**
 * The connector registry: a searchable catalog of discoverable MCP servers.
 * Supports user-installed connectors (from ~/.nemo/connectors/) and
 * built-in connectors (curated list above).
 */
export class ConnectorRegistry {
  private static instance: ConnectorRegistry | null = null
  private connectors: ConnectorEntry[] = []
  private builtinIds = new Set<string>()
  private userDir: string

  private constructor() {
    this.userDir = path.join(os.homedir(), ".nemo", "connectors")
  }

  static getInstance(): ConnectorRegistry {
    if (!ConnectorRegistry.instance) {
      ConnectorRegistry.instance = new ConnectorRegistry()
    }
    return ConnectorRegistry.instance
  }

  /** Load all connectors (built-in + user-installed). */
  load(): ConnectorEntry[] {
    this.connectors = [...BUILTIN_CONNECTORS]
    this.builtinIds = new Set(BUILTIN_CONNECTORS.map((c) => c.id))

    if (fs.existsSync(this.userDir)) {
      const entries = fs.readdirSync(this.userDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue
        try {
          const raw = fs.readFileSync(path.join(this.userDir, entry.name), "utf8")
          const parsed = JSON.parse(raw) as Partial<ConnectorEntry>
          if (parsed.id && parsed.spec) {
            this.connectors.push({
              id: parsed.id,
              name: parsed.name ?? parsed.id,
              description: parsed.description ?? "",
              keywords: parsed.keywords ?? [],
              spec: parsed.spec,
              npmPackage: parsed.npmPackage,
              category: parsed.category,
            })
          }
        } catch {
          // skip malformed
        }
      }
    }

    return this.connectors
  }

  /**
   * Search connectors by keyword query. Returns ranked matches.
   *
   * The query a model sends is prose, not a keyword: "node server http serve
   * localhost command execution" is one phrase, and matching it token-by-token
   * against exact spellings found NOTHING — the model then had no server to
   * pick and flailed. Each token is therefore expanded into the spellings it
   * could plausibly be (see `tokenVariants`), so "serve" reaches "server" and
   * "execution" reaches "execute".
   */
  search(query: string): ConnectorEntry[] {
    if (!this.connectors.length) this.load()

    const lower = query.toLowerCase().trim()
    if (!lower) return this.connectors

    const tokens = lower.split(/\s+/).filter((t) => t.length > 1)

    return this.connectors
      .map((c) => {
        const searchable =
          `${c.id} ${c.name} ${c.description} ${(c.keywords ?? []).join(" ")} ${c.category ?? ""} ${c.npmPackage ?? ""}`.toLowerCase()
        let score = 0
        for (const token of tokens) {
          for (const variant of tokenVariants(token)) {
            if (c.id === variant) score += 10
            if (c.name.toLowerCase() === variant) score += 8
            if (c.keywords?.some((k) => k.toLowerCase() === variant)) score += 6
            if (c.category?.toLowerCase() === variant) score += 4
            if (searchable.includes(variant)) score += 2
          }
        }
        return { connector: c, score }
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.connector)
  }

  /** Get a connector by ID. */
  get(id: string): ConnectorEntry | undefined {
    if (!this.connectors.length) this.load()
    return this.connectors.find((c) => c.id === id)
  }

  /** Get connectors by category. */
  getByCategory(category: string): ConnectorEntry[] {
    if (!this.connectors.length) this.load()
    return this.connectors.filter((c) => c.category === category)
  }

  /** Get all categories. */
  getCategories(): string[] {
    if (!this.connectors.length) this.load()
    return [...new Set(this.connectors.map((c) => c.category as string).filter(Boolean))].sort()
  }

  /** Register a user-installed connector. */
  register(connector: ConnectorEntry): void {
    const userFile = path.join(this.userDir, `${connector.id}.json`)
    fs.mkdirSync(this.userDir, { recursive: true })
    fs.writeFileSync(userFile, JSON.stringify(connector, null, 2))
    if (!this.connectors.find((c) => c.id === connector.id)) {
      this.connectors.push(connector)
    }
  }

  /** Uninstall a user connector (does nothing for built-in). */
  unregister(id: string): boolean {
    if (this.builtinIds.has(id)) return false
    const idx = this.connectors.findIndex((c) => c.id === id)
    if (idx < 0) return false
    const entry = this.connectors[idx]
    this.connectors.splice(idx, 1)
    const userFile = path.join(this.userDir, `${entry.id}.json`)
    if (fs.existsSync(userFile)) fs.unlinkSync(userFile)
    return true
  }

  /** Get all connector IDs (for the "what's installed" check). */
  getAllIds(): string[] {
    if (!this.connectors.length) this.load()
    return this.connectors.map((c) => c.id)
  }
}

export function getConnectorRegistry(): ConnectorRegistry {
  return ConnectorRegistry.getInstance()
}

export function searchConnectors(query: string): ConnectorEntry[] {
  return getConnectorRegistry().search(query)
}
