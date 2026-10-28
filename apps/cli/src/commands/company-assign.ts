/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * `/company assign <task>` — the company-formation logic: take ONE user task
 * and divide it into focused workstreams, each routed to the best employee
 * on the roster. Pure and deterministic: no fs, no env, no model — scoring is
 * keyword overlap against employee names/descriptions plus division routing
 * hints, so every assignment is explainable (`matched:`) and unit-testable
 * without network. The caller owns loading (company-library resolves the
 * root and reads divisions/agents); this module only plans and formats.
 */

/** Structural view of a roster employee — company-library's `CompanyAgent`
 *  satisfies it, so the wiring passes its objects through untouched. */
export interface AssignWorker {
  readonly name: string
  readonly division: string
  readonly description: string
}

export interface AssignDept {
  readonly id: string
  readonly label: string
}

export interface WorkAssignment {
  readonly worker: AssignWorker
  /** Display label of the worker's department. */
  readonly deptLabel: string
  /** Clause text (multi-clause split) or matched focus tokens (cluster split). */
  readonly focus: string
  /** Up to four tokens that earned the match — the "why" of the routing. */
  readonly matched: readonly string[]
}

export interface WorkPlan {
  readonly task: string
  readonly assignments: readonly WorkAssignment[]
  /** Workstreams no employee description matched — reported, never guessed. */
  readonly unmatched: readonly string[]
  /** Set when the task had more clauses than the display cap. */
  readonly note?: string
}

/** Generic task verbs/filler dropped before scoring so routing keys on the
 *  domain words ("build the api" → [api]). */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "also",
  "plus",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "onto",
  "to",
  "with",
  "via",
  "per",
  "over",
  "under",
  "across",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "done",
  "again",
  "i",
  "we",
  "you",
  "they",
  "he",
  "she",
  "it",
  "me",
  "my",
  "our",
  "ours",
  "your",
  "yours",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "how",
  "when",
  "where",
  "why",
  "please",
  "need",
  "needs",
  "want",
  "wants",
  "make",
  "makes",
  "made",
  "create",
  "creates",
  "creating",
  "build",
  "builds",
  "building",
  "write",
  "writes",
  "writing",
  "develop",
  "develops",
  "developing",
  "help",
  "helping",
  "get",
  "gets",
  "give",
  "gives",
  "some",
  "more",
  "most",
  "all",
  "any",
  "every",
  "each",
  "both",
  "very",
  "just",
  "really",
  "too",
  "own",
  "same",
  "other",
  "such",
  "because",
  "while",
  "about",
  "than",
  "well",
  "way",
  "run",
  "running",
  "ran",
  "execute",
])

/**
 * Routing prior: division id → domain keywords. Description overlap is the
 * real signal; these bias the cluster split when one clause spans domains
 * (landing page + payments → design AND engineering from hints alone).
 * Tokens never contain `-` (split away), so neither do these keys.
 */
const DEPT_HINTS: Record<string, readonly string[]> = {
  engineering: [
    "code",
    "codes",
    "coding",
    "api",
    "apis",
    "backend",
    "frontend",
    "web",
    "app",
    "apps",
    "application",
    "applications",
    "software",
    "database",
    "databases",
    "sql",
    "deploy",
    "deployment",
    "docker",
    "kubernetes",
    "refactor",
    "refactoring",
    "bug",
    "bugs",
    "debug",
    "debugging",
    "script",
    "scripts",
    "integration",
    "integrations",
    "pipeline",
    "pipelines",
    "data",
    "ml",
    "ai",
    "cloud",
    "server",
    "servers",
    "website",
    "site",
    "typescript",
    "javascript",
    "python",
    "node",
    "react",
    "schema",
    "schemas",
    "migration",
    "migrations",
    "cli",
    "framework",
    "sdk",
    "rest",
    "queue",
    "caching",
    "architecture",
  ],
  design: [
    "design",
    "designs",
    "designing",
    "ui",
    "ux",
    "visual",
    "logo",
    "logos",
    "brand",
    "branding",
    "mockup",
    "mockups",
    "wireframe",
    "wireframes",
    "figma",
    "typography",
    "color",
    "colors",
    "palette",
    "layout",
    "layouts",
    "graphic",
    "graphics",
    "illustration",
    "illustrations",
    "aesthetic",
    "style",
    "styling",
    "theme",
    "themes",
    "icon",
    "icons",
    "poster",
    "banner",
  ],
  testing: [
    "test",
    "tests",
    "testing",
    "qa",
    "coverage",
    "regression",
    "regressions",
    "e2e",
    "playwright",
    "selenium",
    "accessibility",
    "a11y",
    "benchmark",
    "benchmarks",
    "validation",
    "validate",
    "flaky",
    "sanity",
    "smoke",
  ],
  marketing: [
    "marketing",
    "seo",
    "campaign",
    "campaigns",
    "social",
    "content",
    "copy",
    "copywriting",
    "audience",
    "growth",
    "email",
    "newsletter",
    "newsletters",
    "influencer",
    "community",
    "reddit",
    "linkedin",
    "twitter",
    "instagram",
    "tiktok",
    "youtube",
    "blog",
    "blogs",
    "awareness",
    "engagement",
    "storytelling",
  ],
  "paid-media": [
    "ads",
    "ad",
    "ppc",
    "roas",
    "cpc",
    "cpm",
    "bidding",
    "bid",
    "retargeting",
    "media",
    "spend",
    "advertising",
    "programmatic",
    "display",
  ],
  sales: [
    "sales",
    "crm",
    "lead",
    "leads",
    "deal",
    "deals",
    "outreach",
    "demo",
    "demos",
    "negotiation",
    "negotiate",
    "prospecting",
    "prospect",
    "prospects",
    "pipeline",
    "funnel",
    "quota",
    "closing",
    "pitch",
  ],
  finance: [
    "finance",
    "financial",
    "budget",
    "budgets",
    "invoice",
    "invoices",
    "invoicing",
    "billing",
    "payment",
    "payments",
    "pricing",
    "price",
    "revenue",
    "tax",
    "taxes",
    "accounting",
    "cost",
    "costs",
    "forecast",
    "forecasts",
    "payroll",
    "expense",
    "expenses",
    "profit",
    "cash",
  ],
  security: [
    "security",
    "secure",
    "vulnerability",
    "vulnerabilities",
    "vuln",
    "auth",
    "authentication",
    "authorization",
    "encrypt",
    "encryption",
    "pentest",
    "penetration",
    "threat",
    "threats",
    "compliance",
    "secrets",
    "secret",
    "owasp",
    "xss",
    "csrf",
    "malware",
    "phishing",
    "audit",
    "forensics",
  ],
  research: [
    "research",
    "literature",
    "survey",
    "surveys",
    "papers",
    "study",
    "studies",
    "hypothesis",
    "citation",
    "citations",
    "findings",
    "methodology",
    "experiment",
    "experiments",
  ],
  product: [
    "product",
    "products",
    "roadmap",
    "roadmaps",
    "spec",
    "specs",
    "specification",
    "specifications",
    "requirement",
    "requirements",
    "stories",
    "story",
    "prioritization",
    "prd",
    "discovery",
    "epic",
    "epics",
  ],
  "project-management": [
    "project",
    "projects",
    "milestone",
    "milestones",
    "timeline",
    "timelines",
    "sprint",
    "sprints",
    "stakeholder",
    "stakeholders",
    "risk",
    "risks",
    "schedule",
    "scheduling",
    "backlog",
    "coordination",
    "delivery",
  ],
  support: [
    "support",
    "ticket",
    "tickets",
    "customer",
    "customers",
    "helpdesk",
    "escalation",
    "escalations",
    "faq",
    "onboarding",
    "churn",
    "sla",
    "complaint",
    "complaints",
    "training",
  ],
  healthcare: [
    "patient",
    "patients",
    "clinical",
    "clinic",
    "medical",
    "medicine",
    "health",
    "healthcare",
    "diagnosis",
    "diagnostic",
    "hipaa",
    "therapy",
  ],
  gis: [
    "gis",
    "map",
    "maps",
    "mapping",
    "geospatial",
    "geo",
    "coordinate",
    "coordinates",
    "gps",
    "cartography",
    "cartographic",
    "terrain",
    "elevation",
    "satellite",
    "topography",
    "qgis",
    "arcgis",
  ],
  academic: [
    "academic",
    "academics",
    "thesis",
    "dissertation",
    "coursework",
    "curriculum",
    "lecture",
    "lectures",
    "syllabus",
    "plagiarism",
    "citation",
    "citations",
    "essay",
    "essays",
  ],
  "game-development": [
    "game",
    "games",
    "gaming",
    "gamedev",
    "unity",
    "unreal",
    "gameplay",
    "sprite",
    "sprites",
    "level",
    "levels",
    "avatar",
    "npc",
  ],
  "spatial-computing": ["ar", "vr", "xr", "reality", "headset", "headsets", "holographic", "oculus", "quest"],
}

/** Clause split: connectors the raw task breaks on before scoring. */
const CLAUSE_SPLIT = /\s*(?:,|;|&|\+|\band\b|\bthen\b|\bplus\b|\bas well as\b|\bwhile\b)\s*/i

/** One division can own the whole clause — cluster at most this many. */
const MAX_CLUSTERS = 3
/** Guard against pathological tasks; overflow lands in `note`. */
const MAX_CLAUSES = 12

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Name word count — ties go to the generalist (fewer words = broader
 *  mandate: "SEO Strategist" over "Baidu SEO Specialist" for a bare match). */
function nameWords(name: string): number {
  return name.trim().split(/\s+/).length
}

/** Substring hits need length ≥ 3 (`search` would swallow `ar`); short
 *  tokens match on word boundaries only, `+`-bearing tokens get escaped. */
function hits(text: string, token: string): boolean {
  if (token.length >= 3) return text.includes(token)
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}($|[^a-z0-9])`).test(text)
}

/** Lowercase word tokens, stopwords and duplicates removed, order kept. */
function tokenize(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

function splitClauses(task: string): string[] {
  return task
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.replace(/"/g, "").trim())
    .filter(Boolean)
}

function scoreWorker(worker: AssignWorker, toks: readonly string[]): { score: number; matched: string[] } {
  const name = worker.name.toLowerCase()
  const desc = worker.description.toLowerCase()
  let score = 0
  const matched: string[] = []
  for (const t of toks) {
    if (hits(name, t)) {
      score += 3
      matched.push(t)
    } else if (hits(desc, t)) {
      score += 1
      matched.push(t)
    }
  }
  return { score, matched }
}

function scoreDept(
  dept: AssignDept,
  toks: readonly string[],
  byDept: ReadonlyMap<string, readonly AssignWorker[]>,
): { score: number; hitToks: string[] } {
  const hints = DEPT_HINTS[dept.id] ?? []
  const labelWords = dept.label.toLowerCase().split(/[^a-z0-9]+/)
  const roster = byDept.get(dept.id) ?? []
  let score = 0
  const hitToks: string[] = []
  for (const t of toks) {
    let s = 0
    // Both sides ≥ 3 keeps short hints (`ar`, `ad`) from matching inside
    // longer words (`search`, `adapter`).
    if (hints.some((h) => h === t || (t.length >= 3 && h.length >= 3 && (h.includes(t) || t.includes(h))))) s += 3
    if (labelWords.some((w) => w === t)) s += 2
    if (roster.some((w) => hits(w.name.toLowerCase(), t))) s += 2
    else if (roster.some((w) => hits(w.description.toLowerCase(), t))) s += 1
    if (s > 0) {
      score += s
      hitToks.push(t)
    }
  }
  return { score, hitToks }
}

/** Best-scoring not-yet-assigned employee with a positive match; when every
 *  match is taken, reuse beats dropping work (rosters can be small). */
function pickWorker(
  pool: readonly AssignWorker[],
  toks: readonly string[],
  used: ReadonlySet<string>,
): { worker: AssignWorker; matched: string[] } | null {
  const scored = pool.map((worker) => ({ worker, ...scoreWorker(worker, toks) })).filter((x) => x.score > 0)
  if (scored.length === 0) return null
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      nameWords(a.worker.name) - nameWords(b.worker.name) ||
      a.worker.name.localeCompare(b.worker.name),
  )
  const fresh = scored.find((x) => !used.has(x.worker.name))
  const chosen = fresh ?? scored[0]
  return { worker: chosen.worker, matched: chosen.matched }
}

/**
 * Divide `task` across `workers`. Two shapes:
 * - ≥ 2 clauses (split on `,`/`and`/`then`/…): each clause is a workstream,
 *   routed roster-wide to its best distinct employee.
 * - exactly 1 clause: split by department instead (hint + description
 *   overlap per division, top `MAX_CLUSTERS`), so one undivided sentence
 *   still fans out to different departments.
 * Deterministic: same input, same plan.
 */
export function planCompanyWork(
  task: string,
  workers: readonly AssignWorker[],
  depts: readonly AssignDept[],
): WorkPlan {
  if (!task.trim()) return { task, assignments: [], unmatched: [] }
  const byDept = new Map<string, AssignWorker[]>()
  for (const w of workers) {
    const list = byDept.get(w.division) ?? []
    list.push(w)
    byDept.set(w.division, list)
  }
  const label = new Map(depts.map((d) => [d.id, d.label]))
  const used = new Set<string>()
  const assignments: WorkAssignment[] = []
  const unmatched: string[] = []
  const clauses = splitClauses(task).filter((c) => tokenize(c).length > 0)
  if (clauses.length === 0) return { task, assignments, unmatched: [task.trim()] }

  if (clauses.length === 1) {
    const toks = tokenize(clauses[0])
    const ranked = depts
      .map((dept) => ({ dept, ...scoreDept(dept, toks, byDept) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.dept.label.localeCompare(b.dept.label))
      .slice(0, MAX_CLUSTERS)
    if (ranked.length === 0) return { task, assignments, unmatched: [clauses[0]] }
    for (const r of ranked) {
      const pick = pickWorker(byDept.get(r.dept.id) ?? [], toks, used)
      if (!pick) continue
      assignments.push({
        worker: pick.worker,
        deptLabel: r.dept.label,
        focus: r.hitToks.join(", "),
        matched: r.hitToks.slice(0, 4),
      })
      used.add(pick.worker.name)
    }
    if (assignments.length === 0) unmatched.push(clauses[0])
    return { task, assignments, unmatched }
  }

  const shown = clauses.slice(0, MAX_CLAUSES)
  for (const clause of shown) {
    const toks = tokenize(clause)
    const pick = pickWorker(workers, toks, used)
    if (!pick) {
      unmatched.push(clause)
      continue
    }
    assignments.push({
      worker: pick.worker,
      deptLabel: label.get(pick.worker.division) ?? pick.worker.division,
      focus: clause,
      matched: pick.matched.slice(0, 4),
    })
    used.add(pick.worker.name)
  }
  const note =
    clauses.length > shown.length
      ? `${clauses.length - shown.length} more clause(s) beyond the first ${MAX_CLAUSES} not divided.`
      : undefined
  return note ? { task, assignments, unmatched, note } : { task, assignments, unmatched }
}

export function formatCompanyWork(plan: WorkPlan, deptCount: number, workerCount: number): string {
  const header = `Company formed: ${deptCount} departments · ${workerCount} employees.`
  if (plan.assignments.length === 0 && plan.unmatched.length === 0 && !plan.note) {
    return `${header}\nNothing to divide.`
  }
  const lines: string[] = [header, ""]
  if (plan.assignments.length > 0) {
    const n = plan.assignments.length
    lines.push(`Work divided into ${n} assignment${n === 1 ? "" : "s"}:`)
    plan.assignments.forEach((a, i) => {
      lines.push(`${i + 1}. [${a.deptLabel}] ${a.worker.name}`)
      lines.push(`   scope: "${a.focus}"`)
      if (a.matched.length > 0) lines.push(`   matched: ${a.matched.join(", ")}`)
      lines.push(`   run: /company run ${a.worker.name} ${a.focus}`)
    })
  }
  if (plan.unmatched.length > 0) {
    if (plan.assignments.length > 0) lines.push("")
    lines.push(`No specialist matched: ${plan.unmatched.map((u) => `"${u}"`).join(", ")} — browse with /company list.`)
  }
  if (plan.note) {
    lines.push("")
    lines.push(`Note: ${plan.note}`)
  }
  return lines.join("\n")
}

/** One launchable unit for the TUI fan-out — same `{type, prompt}` shape
 *  `launchMany` feeds into the bounded-wave subagent runner. */
export interface AssignLaunch {
  readonly type: string
  readonly prompt: string
}

/** Assignments → launch pairs (employee name, scope prompt). Empty when
 *  nothing divided — the caller reports instead of launching nothing. */
export function assignmentsToLaunches(plan: WorkPlan): AssignLaunch[] {
  return plan.assignments.map((a) => ({ type: a.worker.name, prompt: a.focus }))
}

/**
 * One-shot entry point for the `/company assign` wiring: usage guard,
 * empty-roster guard, then plan + format.
 */
export function assignCompanyWork(
  task: string,
  workers: readonly AssignWorker[],
  depts: readonly AssignDept[],
): string {
  const trimmed = task.trim()
  if (!trimmed) return "Usage: /company assign <task>"
  if (workers.length === 0) return "Company library has no employees to assign."
  return formatCompanyWork(planCompanyWork(trimmed, workers, depts), depts.length, workers.length)
}
