/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, expect, it } from "vitest"

import {
  assignCompanyWork,
  assignmentsToLaunches,
  planCompanyWork,
  type AssignDept,
  type AssignWorker,
} from "./company-assign.js"

const DEPTS: AssignDept[] = [
  { id: "engineering", label: "Engineering" },
  { id: "design", label: "Design" },
  { id: "marketing", label: "Marketing" },
]

const WORKERS: AssignWorker[] = [
  {
    name: "Full-Stack Engineer",
    division: "engineering",
    description: "Builds web apps, APIs, and payment integrations.",
  },
  {
    name: "Data Engineer",
    division: "engineering",
    description: "Designs data pipelines and database schemas.",
  },
  {
    name: "Code Reviewer",
    division: "engineering",
    description: "Reviews code like a mentor.",
  },
  {
    name: "Principal Engineer",
    division: "engineering",
    description: "Reviews code architecture and mentors teams.",
  },
  {
    name: "UI Designer",
    division: "design",
    description: "Designs interfaces, logos, and visual brand systems.",
  },
  {
    name: "Growth Marketer",
    division: "marketing",
    description: "Runs SEO campaigns, social media, and email marketing.",
  },
]

describe("planCompanyWork — clause split routes each clause to a distinct employee", () => {
  it("divides a three-clause task across three departments with run hints", () => {
    const task = "build the api, design a new logo, then write the marketing copy"
    const plan = planCompanyWork(task, WORKERS, DEPTS)
    expect(plan.assignments).toHaveLength(3)

    const byDept = new Map(plan.assignments.map((a) => [a.deptLabel, a.worker.name]))
    expect(byDept.get("Engineering")).toBe("Full-Stack Engineer")
    expect(byDept.get("Design")).toBe("UI Designer")
    expect(byDept.get("Marketing")).toBe("Growth Marketer")

    // "then" split, not a phantom department.
    expect(plan.assignments.map((a) => a.deptLabel)).not.toContain("Then")
    expect(plan.assignments[0].focus).toBe("build the api")
    expect(plan.unmatched).toEqual([])

    const out = assignCompanyWork(task, WORKERS, DEPTS)
    expect(out).toContain("Company formed: 3 departments · 6 employees.")
    expect(out).toContain("Work divided into 3 assignments:")
    expect(out).toContain("run: /company run Full-Stack Engineer build the api")
    expect(out).toContain("matched: api")
  })

  it("enforces distinct employees when two clauses match the same top pick", () => {
    const plan = planCompanyWork("review code and review code again", WORKERS, DEPTS)
    expect(plan.assignments).toHaveLength(2)
    const names = plan.assignments.map((a) => a.worker.name)
    expect(names[0]).toBe("Code Reviewer")
    expect(names[1]).toBe("Principal Engineer") // next best, never a double-book
    expect(new Set(names).size).toBe(2)
  })

  it("is deterministic: same task, byte-identical plan and output", () => {
    const task = "build the api, design a new logo, then write the marketing copy"
    expect(assignCompanyWork(task, WORKERS, DEPTS)).toBe(assignCompanyWork(task, WORKERS, DEPTS))
  })
})

describe("planCompanyWork — single clause fans out by department", () => {
  it("splits an undivided sentence into the hinted departments", () => {
    const plan = planCompanyWork("landing page ui design with payment api integration", WORKERS, DEPTS)
    expect(plan.assignments).toHaveLength(2)
    const divisions = plan.assignments.map((a) => a.deptLabel)
    expect(divisions.sort()).toEqual(["Design", "Engineering"])
    expect(plan.unmatched).toEqual([])

    const design = plan.assignments.find((a) => a.deptLabel === "Design")
    expect(design?.worker.name).toBe("UI Designer")
    // Focus is the matched tokens, in task order — the "why" made visible.
    expect(design?.focus).toBe("ui, design")
  })
})

describe("assignCompanyWork — guards and no-guess reporting", () => {
  it("returns usage for an empty task", () => {
    expect(assignCompanyWork("   ", WORKERS, DEPTS)).toBe("Usage: /company assign <task>")
  })

  it("reports an empty roster instead of an empty plan", () => {
    expect(assignCompanyWork("design a logo", [], DEPTS)).toBe("Company library has no employees to assign.")
  })

  it("reports no-match clauses honestly with a browse hint", () => {
    const out = assignCompanyWork("buy groceries for dinner tonight", WORKERS, DEPTS)
    expect(out).toContain("Company formed: 3 departments · 6 employees.")
    expect(out).toContain("No specialist matched:")
    expect(out).toContain("browse with /company list")
    expect(out).not.toContain("Work divided")
  })

  it("never routes a task made only of stopwords to a random employee", () => {
    const plan = planCompanyWork("please help me", WORKERS, DEPTS)
    expect(plan.assignments).toEqual([])
    expect(plan.unmatched).toEqual(["please help me"])
  })

  it("falls back to the division id when a worker's division has no label", () => {
    const roster: AssignWorker[] = [
      ...WORKERS,
      { name: "Policy Analyst", division: "policy", description: "Reviews policy documents for compliance." },
    ]
    const plan = planCompanyWork("update the policy documents, and file the report", roster, DEPTS)
    const policy = plan.assignments.find((a) => a.worker.name === "Policy Analyst")
    expect(policy).toBeDefined()
    expect(policy?.deptLabel).toBe("policy") // no label registered — id is the honest display
  })
})

describe("tie-breaks and fan-out pairs", () => {
  it("prefers the generalist when scores tie (SEO Strategist over Baidu SEO Specialist)", () => {
    const seo: AssignWorker[] = [
      { name: "Baidu SEO Specialist", division: "marketing", description: "Optimizes Baidu search rankings." },
      { name: "SEO Strategist", division: "marketing", description: "Plans SEO strategies for organic growth." },
    ]
    const plan = planCompanyWork("seo campaigns", seo, DEPTS)
    expect(plan.assignments).toHaveLength(1)
    expect(plan.assignments[0].worker.name).toBe("SEO Strategist")
  })

  it("maps assignments to {type, prompt} launch pairs for the TUI fan-out", () => {
    const plan = planCompanyWork("build the api, design a new logo", WORKERS, DEPTS)
    expect(assignmentsToLaunches(plan)).toEqual([
      { type: "Full-Stack Engineer", prompt: "build the api" },
      { type: "UI Designer", prompt: "design a new logo" },
    ])
    expect(assignmentsToLaunches(planCompanyWork("", WORKERS, DEPTS))).toEqual([])
  })
})
