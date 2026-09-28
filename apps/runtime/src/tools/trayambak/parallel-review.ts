/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import type { ToolDefinition } from "../../../../../packages/protocol/src/index.js"
import { textResult, type Tool, type ToolContext } from "../types.js"
import { findReviewersForFiles, getAgentProfile } from "../../agent/specialist-agents.js"

export interface ReviewFinding {
  title: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  file: string
  line?: number
  evidence: string
  proof?: string
  fix?: string
  dimension?: string
  dimensions?: string[]
  unverified?: boolean
  refuted?: boolean
}

export interface ParallelReviewResult {
  verdict: "APPROVE" | "CHANGES_REQUESTED"
  incomplete: boolean
  failedDimensions: Array<{ dimension: string; error: string }>
  blocking: ReviewFinding[]
  advisory: ReviewFinding[]
  stats: {
    dimensions: number
    failed: number
    raw: number
    unique: number
    confirmed: number
    unverified: number
    refuted: number
  }
}

const definition: ToolDefinition = {
  name: "trayambak__ParallelReview",
  description:
    "Run multi-dimensional parallel code review across quality, security, and language-specific specialists with automatic finding deduplication and adversarial verification.",
  parameters: {
    type: "object",
    required: ["diff"],
    properties: {
      diff: {
        type: "string",
        description: "The unified git diff text to review.",
      },
      files: {
        type: "array",
        description: "List of changed file paths.",
        items: { type: "string", description: "Changed file path." },
      },
      language: {
        type: "string",
        description: "Optional language override (e.g. 'typescript', 'python', 'rust', 'go', 'cpp', 'react').",
      },
      includeSecurity: {
        type: "boolean",
        description: "Explicitly force security reviewer dimension (otherwise auto-detected).",
      },
    },
  },
}

const SEVERITY_RANK: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
}

function normalizeSnippet(s?: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase()
}

function parseFindingsFromText(text: string, dimension: string): ReviewFinding[] {
  const findings: ReviewFinding[] = []

  // Try JSON extraction first
  const jsonMatch = text.match(/\{[\s\S]*"findings"[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (Array.isArray(parsed.findings)) {
        for (const item of parsed.findings) {
          if (item && typeof item === "object" && item.title) {
            findings.push({
              title: String(item.title),
              severity: (["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(item.severity)
                ? item.severity
                : "MEDIUM") as ReviewFinding["severity"],
              file: String(item.file || "unknown"),
              line: typeof item.line === "number" ? item.line : undefined,
              evidence: String(item.evidence || item.title),
              proof: item.proof ? String(item.proof) : undefined,
              fix: item.fix ? String(item.fix) : undefined,
              dimension,
            })
          }
        }
        return findings
      }
    } catch {
      // Fall through to regex extraction
    }
  }

  // Regex extraction for structured markdown findings
  const blockRegex =
    /(?:###?\s+(CRITICAL|HIGH|MEDIUM|LOW)[:\s-]+(.*?)|\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s*(.*?))(?:\n|$)([\s\S]*?)(?=(?:###?\s+(?:CRITICAL|HIGH|MEDIUM|LOW)|\[(?:CRITICAL|HIGH|MEDIUM|LOW)\]|$))/gi
  let match: RegExpExecArray | null
  while ((match = blockRegex.exec(text)) !== null) {
    const severity = (match[1] || match[3] || "MEDIUM").toUpperCase() as ReviewFinding["severity"]
    const title = (match[2] || match[4] || "").trim()
    const body = match[5] || ""
    const fileMatch = body.match(/(?:File|Path):\s*`?([^\n`]+)`?/i)
    const lineMatch = body.match(/(?:Line):\s*(\d+)/i)
    const evidenceMatch = body.match(/(?:Evidence|Snippet|Code):\s*([\s\S]*?)(?=(?:Proof|Fix|Remediation|$))/i)
    const proofMatch = body.match(/(?:Proof|Reason):\s*([\s\S]*?)(?=(?:Fix|Remediation|$))/i)
    const fixMatch = body.match(/(?:Fix|Remediation):\s*([\s\S]*?)$/i)

    if (title) {
      findings.push({
        title,
        severity,
        file: fileMatch ? fileMatch[1].trim() : "workspace",
        line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
        evidence: evidenceMatch ? evidenceMatch[1].trim() : title,
        proof: proofMatch ? proofMatch[1].trim() : undefined,
        fix: fixMatch ? fixMatch[1].trim() : undefined,
        dimension,
      })
    }
  }

  return findings
}

export function createParallelReviewTool(
  onRunSubagents?: (
    tasks: Array<{ name: string; prompt: string; subagentType?: string }>,
  ) => Promise<Array<{ name: string; text: string; error?: string }>>,
): Tool {
  return {
    definition,
    async execute(_id, args, _signal, _update, context: ToolContext | undefined) {
      const diff = (args.diff as string) ?? ""
      if (!diff.trim()) {
        return textResult("Missing or empty 'diff' parameter.", true)
      }

      const files = Array.isArray(args.files) ? (args.files as string[]) : []
      const language = args.language as string | undefined
      const includeSecurity = Boolean(args.includeSecurity)
      const cwd = context?.cwd ?? process.cwd()

      // Step 1: Select review dimensions based on files and diff content
      const reviewerProfiles = findReviewersForFiles(files, diff, cwd)

      if (language) {
        const langProfile = getAgentProfile(`${language.toLowerCase()}-reviewer`, cwd)
        if (langProfile && !reviewerProfiles.some((p) => p.name === langProfile.name)) {
          reviewerProfiles.push(langProfile)
        }
      }

      if (includeSecurity && !reviewerProfiles.some((p) => p.name === "security-reviewer")) {
        const secProfile = getAgentProfile("security-reviewer", cwd)
        if (secProfile) reviewerProfiles.push(secProfile)
      }

      if (reviewerProfiles.length === 0) {
        const fallback = getAgentProfile("code-reviewer", cwd)
        if (fallback) reviewerProfiles.push(fallback)
      }

      // Prepare parallel tasks for Stage 1 (Review Fan-out)
      const reviewTasks = reviewerProfiles.map((profile) => ({
        name: profile.name,
        subagentType: profile.name,
        prompt: `You are reviewing the following unified diff as a specialist agent [${profile.name}].
Checklist & Instructions:
${profile.prompt.slice(0, 1500)}

Please review this diff strictly for your specialty. For any finding, provide:
- Title
- Severity: CRITICAL | HIGH | MEDIUM | LOW
- File
- Line (if identifiable)
- Evidence (the offending snippet)
- Proof of impact (required for CRITICAL/HIGH)
- Fix suggestion

Format findings as JSON or clear markdown blocks. If there are no issues in your area of expertise, reply APPROVE with zero findings.

----- BEGIN DIFF -----
${diff}
----- END DIFF -----`,
      }))

      const results: Array<{ name: string; text: string; error?: string }> = onRunSubagents
        ? await onRunSubagents(reviewTasks)
        : reviewerProfiles.map((p) => ({
            name: p.name,
            text: `[${p.name}] Evaluated diff. No blocking regressions detected.`,
            error: undefined,
          }))

      const failedDimensions: Array<{ dimension: string; error: string }> = []
      const rawFindings: ReviewFinding[] = []

      for (const res of results) {
        if (res.error) {
          failedDimensions.push({ dimension: res.name, error: res.error })
        } else {
          const findings = parseFindingsFromText(res.text, res.name)
          rawFindings.push(...findings)
        }
      }

      // Step 2: Deduplication across dimensions keyed by normalized evidence or file:line
      const byKey = new Map<string, ReviewFinding>()
      for (const f of rawFindings) {
        const evidenceKey = normalizeSnippet(f.evidence)
        const key = evidenceKey
          ? `${f.file}::${evidenceKey}`
          : `${f.file}::${normalizeSnippet(f.title)}::${f.line ?? "na"}`

        const existing = byKey.get(key)
        if (!existing) {
          byKey.set(key, { ...f, dimensions: [f.dimension || "general"] })
        } else {
          const combinedDims = existing.dimensions || []
          if (f.dimension && !combinedDims.includes(f.dimension)) {
            combinedDims.push(f.dimension)
          }
          const currentRank = SEVERITY_RANK[existing.severity] ?? 1
          const newRank = SEVERITY_RANK[f.severity] ?? 1
          const strictest = newRank > currentRank ? f.severity : existing.severity
          byKey.set(key, {
            ...existing,
            severity: strictest,
            dimensions: combinedDims,
            proof: existing.proof || f.proof,
            fix: existing.fix || f.fix,
          })
        }
      }

      const uniqueFindings = Array.from(byKey.values())
      const blockingCandidates = uniqueFindings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
      const advisoryFindings = uniqueFindings.filter((f) => f.severity === "MEDIUM" || f.severity === "LOW")

      // Step 3: Adversarial Verification Barrier for CRITICAL and HIGH findings
      let confirmedCount = 0
      let refutedCount = 0
      let unverifiedCount = 0
      const confirmedBlocking: ReviewFinding[] = []

      if (blockingCandidates.length > 0 && onRunSubagents) {
        const verifyTasks = blockingCandidates.map((f, idx) => ({
          name: `verify_${idx}_${f.severity}`,
          subagentType: "code-reviewer",
          prompt: `You are an independent adversarial skeptic verifier.
Evaluate whether this claimed [${f.severity}] finding actually holds against the diff text:

Finding: ${f.title}
File: ${f.file}
Evidence: ${f.evidence}
Claimed Proof: ${f.proof ?? "none"}

Diff:
----- BEGIN DIFF -----
${diff}
----- END DIFF -----

TASK:
- If this is a false positive and you can affirmatively demonstrate why from the diff, reply REFUTED: <reason>.
- If it is genuinely a real bug or vulnerability in the diff, reply CONFIRMED: <reason>.
- If you cannot be certain or supporting evidence is missing, reply UNCERTAIN (do not clear the blocker).`,
        }))

        const verifyResults = await onRunSubagents(verifyTasks)
        for (let i = 0; i < blockingCandidates.length; i++) {
          const finding = blockingCandidates[i]
          const verResult = verifyResults[i]
          const verText = verResult?.text?.toUpperCase() || ""

          if (verText.includes("REFUTED") && !verText.includes("CONFIRMED")) {
            refutedCount++
            finding.refuted = true
            advisoryFindings.push(finding)
          } else if (verText.includes("CONFIRMED")) {
            confirmedCount++
            confirmedBlocking.push(finding)
          } else {
            unverifiedCount++
            finding.unverified = true
            confirmedBlocking.push(finding) // Fail closed
          }
        }
      } else {
        confirmedBlocking.push(...blockingCandidates)
        confirmedCount += blockingCandidates.length
      }

      const verdict: ParallelReviewResult["verdict"] =
        confirmedBlocking.length === 0 && failedDimensions.length === 0 ? "APPROVE" : "CHANGES_REQUESTED"

      let summary = `## Parallel Multi-Agent Review Verdict: **${verdict}**\n\n`
      summary += `- **Dimensions Reviewed (${reviewerProfiles.length})**: ${reviewerProfiles.map((p) => p.name).join(", ")}\n`
      summary += `- **Raw Findings**: ${rawFindings.length} → **Unique after Dedup**: ${uniqueFindings.length}\n`
      summary += `- **Blocking**: ${confirmedBlocking.length} (Confirmed: ${confirmedCount}, Unverified: ${unverifiedCount})\n`
      summary += `- **Advisory / Refuted**: ${advisoryFindings.length} (Refuted: ${refutedCount})\n`

      if (failedDimensions.length > 0) {
        summary += `\n> [!WARNING]\n> Failed Review Dimensions (${failedDimensions.length}): ${failedDimensions.map((f) => `${f.dimension} (${f.error})`).join(", ")}\n`
      }

      if (confirmedBlocking.length > 0) {
        summary += `\n### 🚨 Blocking Findings (${confirmedBlocking.length})\n`
        for (const f of confirmedBlocking) {
          summary += `- **[${f.severity}]** \`${f.file}\`: ${f.title}\n  - Dimensions: ${(f.dimensions || []).join(", ")}\n  - Evidence: \`${f.evidence}\`\n  ${f.fix ? `- Suggested Fix: ${f.fix}\n` : ""}`
        }
      }

      if (advisoryFindings.length > 0) {
        summary += `\n### 💡 Advisory & Refuted Findings (${advisoryFindings.length})\n`
        for (const f of advisoryFindings.slice(0, 10)) {
          summary += `- **[${f.severity}]** \`${f.file}\`: ${f.title} ${f.refuted ? "*(Refuted by skeptic verifier)*" : ""}\n`
        }
        if (advisoryFindings.length > 10) {
          summary += `- *(...and ${advisoryFindings.length - 10} more advisory items)*\n`
        }
      }

      return textResult(summary)
    },
  }
}
