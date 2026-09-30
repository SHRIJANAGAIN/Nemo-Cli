/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

/**
 * Hallucination Control — Evidence-based verification for AI output.
 * Distinguishes between CLAIM and EVIDENCE.
 * Categories: FACT, OBSERVATION, INFERENCE, ASSUMPTION, UNKNOWN
 */

export type EvidenceType = "FACT" | "OBSERVATION" | "INFERENCE" | "ASSUMPTION" | "UNKNOWN"

export interface HallucinationResult {
  isHallucination: boolean
  type: EvidenceType
  detail: string
  confidence: number
  requiresEvidence: boolean
}

export interface HallucinationConfig {
  /** Phrases that indicate uncertainty */
  uncertaintyPhrases: string[]
  /** Phrases that indicate claims without evidence */
  claimPhrases: string[]
  /** Minimum confidence threshold */
  minConfidence: number
}

const DEFAULT_CONFIG: HallucinationConfig = {
  uncertaintyPhrases: [
    "i think",
    "i believe",
    "probably",
    "maybe",
    "might be",
    "could be",
    "it seems",
    "appears to",
    "likely",
    "possibly",
    "i guess",
    "i assume",
  ],
  claimPhrases: [
    "i fixed",
    "i resolved",
    "i solved",
    "the bug is fixed",
    "it works",
    "the code is correct",
    "the implementation is done",
    "the solution works",
    "i have implemented",
    "i have added",
    "i have modified",
    "i have updated",
  ],
  minConfidence: 0.7,
}

export class HallucinationDetector {
  private config: HallucinationConfig
  private buffer = ""
  private claims: Array<{ text: string; hasEvidence: boolean; type: EvidenceType }> = []

  constructor(config: Partial<HallucinationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  reset(): void {
    this.buffer = ""
    this.claims = []
  }

  /**
   * Analyze text for potential hallucinations.
   * Returns HallucinationResult with evidence classification.
   */
  analyze(text: string): HallucinationResult {
    this.buffer += text
    const lower = text.toLowerCase()

    // Check for uncertainty phrases
    for (const phrase of this.config.uncertaintyPhrases) {
      if (lower.includes(phrase)) {
        return {
          isHallucination: false,
          type: "ASSUMPTION",
          detail: `Uncertainty phrase detected: "${phrase}"`,
          confidence: 0.5,
          requiresEvidence: true,
        }
      }
    }

    // Check for claims without evidence
    for (const phrase of this.config.claimPhrases) {
      if (lower.includes(phrase)) {
        const hasEvidence = this.hasEvidence(text)
        if (!hasEvidence) {
          return {
            isHallucination: true,
            type: "UNKNOWN",
            detail: `Claim without evidence: "${phrase}"`,
            confidence: 0.3,
            requiresEvidence: true,
          }
        }
        return {
          isHallucination: false,
          type: "FACT",
          detail: `Claim with evidence: "${phrase}"`,
          confidence: 0.8,
          requiresEvidence: false,
        }
      }
    }

    // Check for factual statements
    if (this.isFactualStatement(text)) {
      return {
        isHallucination: false,
        type: "FACT",
        detail: "Factual statement detected",
        confidence: 0.9,
        requiresEvidence: false,
      }
    }

    return {
      isHallucination: false,
      type: "OBSERVATION",
      detail: "Observation or neutral statement",
      confidence: 0.7,
      requiresEvidence: false,
    }
  }

  /**
   * Check if text contains evidence (code, test results, file references).
   */
  private hasEvidence(text: string): boolean {
    const evidencePatterns = [
      /exit code\s*[:=]?\s*\d+/i,
      /test[s]?\s*(passed|failed|passed)/i,
      /`[^`]+`/,
      /```[\s\S]*?```/,
      /file[s]?\s*[:=]\s*[^\s]+/i,
      /line\s*\d+/i,
      /error[s]?\s*[:=]\s*[^\s]+/i,
      /warning[s]?\s*[:=]\s*[^\s]+/i,
      /git\s+(diff|log|status|show)/i,
      /npm\s+(test|run|start)/i,
      /python\s+[^\s]+/i,
      /node\s+[^\s]+/i,
    ]
    return evidencePatterns.some((p) => p.test(text))
  }

  /**
   * Check if text is a factual statement.
   */
  private isFactualStatement(text: string): boolean {
    const factualPatterns = [
      /^(the|a|an)\s+\w+\s+(is|are|was|were)\s+/i,
      /^(it|this|that)\s+(is|are|was|were)\s+/i,
      /contains?\s+\d+/i,
      /version\s*[:=]?\s*[\d.]+/i,
    ]
    return factualPatterns.some((p) => p.test(text))
  }

  /**
   * Classify a statement into evidence type.
   */
  classify(text: string): EvidenceType {
    const lower = text.toLowerCase()
    if (this.config.uncertaintyPhrases.some((p) => lower.includes(p))) return "ASSUMPTION"
    if (this.config.claimPhrases.some((p) => lower.includes(p))) return "INFERENCE"
    if (this.hasEvidence(text)) return "FACT"
    if (this.isFactualStatement(text)) return "OBSERVATION"
    return "UNKNOWN"
  }

  /** Get all detected claims */
  getClaims(): Array<{ text: string; hasEvidence: boolean; type: EvidenceType }> {
    return [...this.claims]
  }
}
