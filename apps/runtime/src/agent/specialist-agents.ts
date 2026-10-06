/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import * as fs from "fs"
import * as os from "os"
import path from "path"
import { companyAgentDirs, resolveCompanyState } from "./company-library.js"
import { loadConfig } from "../config.js"

declare const __dirname: string

export type AgentCategory = "architect" | "reviewer" | "resolver" | "engineer" | "planner" | "optimizer" | "specialist"

export interface AgentProfile {
  name: string
  description: string
  category: AgentCategory
  tools: string[]
  model?: string
  source: string
  prompt: string
  file: string
}

const standardAgentDirectories = [
  [".trayambak", "agents"],
  [".trayambak", "agents"],
  [".trayambak", "agents"],
  [".trayambak", "prompts", "agents"],
  [".kiro", "agents"],
] as const

function determineCategory(name: string): AgentCategory {
  const lower = name.toLowerCase()
  if (lower.includes("architect")) return "architect"
  if (lower.includes("reviewer") || lower.includes("analyzer") || lower.includes("hunter")) return "reviewer"
  if (lower.includes("resolver") || lower.includes("fix")) return "resolver"
  if (lower.includes("planner") || lower.includes("plan")) return "planner"
  if (lower.includes("optimizer") || lower.includes("simplifier") || lower.includes("cleaner")) return "optimizer"
  if (lower.includes("runner") || lower.includes("guide") || lower.includes("miner") || lower.includes("updater"))
    return "engineer"
  return "specialist"
}

function parseAgentFile(filePath: string, source: string): AgentProfile | null {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim()
    if (!content) return null

    let name = path.basename(filePath, path.extname(filePath))
    let description = ""
    let tools: string[] = []
    let model: string | undefined
    let prompt = content

    if (content.startsWith("---")) {
      const closingIndex = content.indexOf("---", 3)
      if (closingIndex !== -1) {
        const frontmatter = content.slice(3, closingIndex).trim()
        prompt = content.slice(closingIndex + 3).trim()

        for (const line of frontmatter.split("\n")) {
          const colonIdx = line.indexOf(":")
          if (colonIdx === -1) continue
          const key = line.slice(0, colonIdx).trim().toLowerCase()
          const val = line.slice(colonIdx + 1).trim()
          if (key === "name" && val) name = val
          else if (key === "description" && val) description = val
          else if (key === "model" && val) model = val
          else if (key === "tools" && val) {
            tools = val
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          }
        }
      }
    }

    return {
      name,
      description,
      category: determineCategory(name),
      tools,
      model,
      source,
      prompt,
      file: filePath,
    }
  } catch {
    return null
  }
}

/**
 * Locate the bundled agents folder inside the trayambak repository or dist structure.
 */
function findBundledAgentsDir(cwd: string): string | null {
  const candidates = [
    path.resolve(__dirname, "../../../../assets/agents"),
    path.resolve(__dirname, "../../../assets/agents"),
    path.resolve(__dirname, "../../assets/agents"),
    path.resolve(cwd, "assets/agents"),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate
    }
  }
  return null
}

export function discoverAgentProfiles(cwd: string, additionalDirectories: string[] = []): AgentProfile[] {
  const profilesMap = new Map<string, AgentProfile>()

  // 1. Bundled built-in specialist agents
  const bundledDir = findBundledAgentsDir(cwd)
  const searchDirs: Array<{ directory: string; source: string }> = []

  if (bundledDir) {
    searchDirs.push({ directory: bundledDir, source: "bundled" })
  }

  // 2. Fallback to external tool library if present
  const externalEcc = path.join(os.homedir(), "OneDrive", "Documents", "tool", "ECC-main", "agents")
  if (fs.existsSync(externalEcc)) {
    searchDirs.push({ directory: externalEcc, source: "library" })
  }

  // 3. Company library: an external agent collection (divisions of .md
  // personas) mounted as one company — every enabled division dir becomes
  // a discovery source, so company agents list AND run as normal profiles.
  // Missing library, master OFF, or fully-disabled = skipped silently
  // (same as a missing workspace dir).
  const companyState = resolveCompanyState(undefined, cwd, os.homedir(), loadConfig())
  if (companyState?.enabled) {
    for (const dir of companyAgentDirs(companyState.root, companyState.disabled)) {
      searchDirs.push({ directory: dir, source: `company/${path.basename(dir)}` })
    }
  }

  // 4. Standard workspace agent dirs
  for (const parts of standardAgentDirectories) {
    searchDirs.push({ directory: path.join(cwd, ...parts), source: parts.join("/") })
  }

  // 5. Configured custom directories
  for (const dir of additionalDirectories) {
    searchDirs.push({ directory: path.resolve(cwd, dir), source: "configured" })
  }

  for (const entry of searchDirs) {
    if (!fs.existsSync(entry.directory)) continue
    let fileEntries: fs.Dirent[]
    try {
      fileEntries = fs.readdirSync(entry.directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !/\.(md|txt|json|toml)$/i.test(fileEntry.name)) continue
      const fullPath = path.join(entry.directory, fileEntry.name)
      const parsed = parseAgentFile(fullPath, entry.source)
      if (parsed) {
        profilesMap.set(parsed.name, parsed)
      }
    }
  }

  return Array.from(profilesMap.values()).sort((a, b) => a.name.localeCompare(b.name))
}

export function getAgentProfile(
  name: string,
  cwd: string = process.cwd(),
  additionalDirectories: string[] = [],
): AgentProfile | undefined {
  const normalized = name
    .toLowerCase()
    .trim()
    .replace(/^trayambak:/, "")
  const all = discoverAgentProfiles(cwd, additionalDirectories)
  return all.find((p) => p.name.toLowerCase() === normalized)
}

const LANGUAGE_REVIEWER_MAP: Record<string, string> = {
  ts: "typescript-reviewer",
  tsx: "typescript-reviewer",
  typescript: "typescript-reviewer",
  js: "typescript-reviewer",
  jsx: "typescript-reviewer",
  javascript: "typescript-reviewer",
  py: "python-reviewer",
  python: "python-reviewer",
  go: "go-reviewer",
  rs: "rust-reviewer",
  rust: "rust-reviewer",
  java: "java-reviewer",
  kt: "kotlin-reviewer",
  kts: "kotlin-reviewer",
  kotlin: "kotlin-reviewer",
  swift: "swift-reviewer",
  php: "php-reviewer",
  cs: "csharp-reviewer",
  csharp: "csharp-reviewer",
  fs: "fsharp-reviewer",
  fsharp: "fsharp-reviewer",
  cpp: "cpp-reviewer",
  cc: "cpp-reviewer",
  cxx: "cpp-reviewer",
  c: "cpp-reviewer",
  dart: "flutter-reviewer",
  flutter: "flutter-reviewer",
}

const SECURITY_PATTERN =
  /\b(auth|login|password|passwd|token|secret|credential|api[_-]?key|session|jwt|oauth|cookie|sql|query|exec|eval|crypto|cipher|hash|hmac|sign|fs\.|readFile|writeFile|fetch|axios|request|subprocess|os\.system)\b/i

const COVERAGE_PATTERN =
  /\b(test|spec|__tests__|coverage|vitest|jest|playwright|pytest|unittest|assert|expect\(|describe\(|it\()\b/i

const PERF_PATTERN =
  /\b(N\+1|n\+1|performance|latency|p95|p99|throughput|memory leak|OOM|setTimeout|setInterval|requestAnimationFrame|Promise\.all|worker|thread|pool|cache|memo|debounce|throttle|virtualize|pagination|index\b|query plan|explain\b)\b|for\s*\(.*;\s*.*<\s*.*\.length|while\s*\(true\)/i

export function findReviewersForFiles(
  files: string[],
  diffText: string = "",
  cwd: string = process.cwd(),
): AgentProfile[] {
  const reviewers: AgentProfile[] = []
  const addedNames = new Set<string>()

  const addProfile = (name: string) => {
    if (addedNames.has(name)) return
    const profile = getAgentProfile(name, cwd)
    if (profile) {
      addedNames.add(name)
      reviewers.push(profile)
    }
  }

  // Base code-reviewer is always added
  addProfile("code-reviewer")

  // Determine language specialists based on file extensions
  for (const file of files) {
    const ext = path.extname(file).replace(".", "").toLowerCase()
    const mapped = LANGUAGE_REVIEWER_MAP[ext]
    if (mapped) addProfile(mapped)

    if (file.toLowerCase().includes("react") || ext === "tsx" || ext === "jsx") {
      addProfile("react-reviewer")
    }
    if (file.toLowerCase().includes("vue") || ext === "vue") {
      addProfile("vue-reviewer")
    }
    if (file.toLowerCase().includes("fastapi")) {
      addProfile("fastapi-reviewer")
    }
    if (file.toLowerCase().includes("django")) {
      addProfile("django-reviewer")
    }
  }

  // Check if security reviewer is needed
  const combinedText = `${files.join(" ")}\n${diffText}`
  if (SECURITY_PATTERN.test(combinedText)) {
    addProfile("security-reviewer")
  }

  // Test-coverage dimension: test files changed, or source logic changed
  // without an accompanying test (legacy Review parity: performance, security,
  // style, test coverage). Bounded to one profile, deduped via addProfile.
  const touchesTests = files.some((f) => COVERAGE_PATTERN.test(f))
  if (touchesTests || COVERAGE_PATTERN.test(diffText)) {
    addProfile("pr-test-analyzer")
  }

  // Performance dimension: perf-sensitive code or hot-loop patterns.
  if (PERF_PATTERN.test(combinedText)) {
    addProfile("performance-optimizer")
  }

  // Silent failure hunter for bug/defect checks
  addProfile("silent-failure-hunter")

  return reviewers
}

export function findBuildResolversForLanguage(language: string, cwd: string = process.cwd()): AgentProfile[] {
  const norm = language.toLowerCase().trim()
  const all = discoverAgentProfiles(cwd)

  const matched = all.filter((p) => {
    if (p.category !== "resolver") return false
    return p.name.includes(norm) || p.name === "build-error-resolver"
  })

  return matched
}
