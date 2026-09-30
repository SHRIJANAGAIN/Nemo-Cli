/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

export interface EvidenceEntry {
  id: string
  claim: string
  evidence: string
  status: "VERIFIED" | "UNVERIFIED" | "CONTRADICTED"
  source: string
  timestamp: string
}

export class EvidenceStore {
  private readonly entries: EvidenceEntry[] = []

  add(claim: string, evidence: string, source: string): EvidenceEntry {
    const entry: EvidenceEntry = {
      id: `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      claim,
      evidence,
      status: "UNVERIFIED",
      source,
      timestamp: new Date().toISOString(),
    }
    this.entries.push(entry)
    return entry
  }

  verify(id: string): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    entry.status = "VERIFIED"
    return true
  }

  contradict(id: string): boolean {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return false
    entry.status = "CONTRADICTED"
    return true
  }

  getUnverified(): EvidenceEntry[] {
    return this.entries.filter((e) => e.status === "UNVERIFIED")
  }

  getVerified(): EvidenceEntry[] {
    return this.entries.filter((e) => e.status === "VERIFIED")
  }

  getContradicted(): EvidenceEntry[] {
    return this.entries.filter((e) => e.status === "CONTRADICTED")
  }

  summary(): string {
    const verified = this.getVerified().length
    const unverified = this.getUnverified().length
    const contradicted = this.getContradicted().length
    return `Evidence: ${verified} verified, ${unverified} unverified, ${contradicted} contradicted`
  }
}
