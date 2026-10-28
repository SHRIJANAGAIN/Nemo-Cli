#!/usr/bin/env python3
"""
Shrijan - Evidence & Hallucination Control
===============================================
Two complementary detectors:

1. Claim-vs-Evidence detector
   A CLAIM without EVIDENCE is not accepted. The detector scans every
   sentence in the assistant's response. Claims that are not backed by
   an evidence marker (test run, file read, command output, git diff,
   typecheck result) are flagged.

2. Statement classifier
   Tags each statement as one of:
     FACT          — directly observable in the world (file contents, command output)
     OBSERVATION   — witnessed but subjective (e.g. "the output looks correct")
     INFERENCE     — derived from facts ("therefore the build is passing")
     ASSUMPTION    — taken for granted ("React 19 is installed" without checking)
     UNKNOWN       — explicitly hedged or admitted ignorance

A response that contains ASSUMPTION or UNKNOWN claims about the result
of an action is downgraded. A response that contains CLAIM without
EVIDENCE is rejected for the code agent pipeline.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Claim vs Evidence
# ---------------------------------------------------------------------------

CLAIM_MARKERS = [
    r"\bI (fixed|solved|resolved|completed|implemented|added|removed|updated|patched|created|wrote|built|ran|tested|verified|optimized|refactored|merged|deployed|installed|configured|set up|initialized|created|generated|imported|exported|wired|hooked|connected|migrated|upgraded|downloaded|installed|ran|executed|started|stopped|restarted|killed|deleted|removed)\b",
    r"\bThe (code|function|method|class|module|file|build|test|server|client|api|route|endpoint|fix|bug|issue|error|feature|component|system|config|setting|option|variable|parameter|argument|value|type|interface|struct|enum|macro|script|program|app|application|service|worker|process|task|job|queue|channel|connection|stream|socket|table|column|row|index|database|migration|schema|model|entity|controller|view|template|layout|page|component|module|package|library|framework|tool|utility|helper|adapter|bridge|driver|plugin|extension|addon|theme|skin|style|sheet|asset|resource|file|directory|folder|path|url|link|reference|pointer|handle|token|session|request|response|middleware|interceptor|filter|guard|pipe|transform|validator|service|provider|factory|builder|strategy|observer|subject|listener|handler|callback|event|signal|message|notification|alert|warning|error|exception|throw|panic|abort|crash|halt|stop|pause|resume|continue|retry|fallback|timeout|cancel|skip|ignore|drain|flush|sync|async|await|promise|future|stream)\b.{0,80}\b(is|was|were|are|has been|have been|had been|will be|should be|must be|now|already|successfully|correctly|properly|fully|completely|done|finished|ready|set|installed|working|running|fixed|patched|resolved|complete)\b",
    r"\bThis (fixes|solves|resolves|implements|adds|removes|updates|handles|supports|enables|disables)\b",
    r"\b(should|will|now) (work|pass|build|run|compile|succeed|complete|function|behave|render|display|return|output|stream|emit|produce)\b",
    r"\b(works?|works correctly|is correct|is fixed|is ready|is done|is complete|is finished|is set up)\b",
]

EVIDENCE_MARKERS = [
    r"\b(test|tests|spec|unit test|integration test|e2e|pytest|jest|mocha|vitest|cargo test|go test|npm test|npm run test|npm run build|tsc|tsc --noEmit|lint|eslint|prettier|ruff|mypy|typecheck|check|format|build) (passes?|passed|fail|fails|failed|succeeded|completed|ok|ran|executed|returned|output) (with|exit code|status|code) [0-9]+\b",
    r"\bexit code [0-9]+\b",
    r"\b(printed|output|stdout|stderr|log|console) (says?|shows?|contains?|returned|is) [`'\"].{1,200}[`'\"]\b",
    r"\bfile [`'\"][^`'\"]+[`'\"].{0,40}(contains|has|includes|defines|exports|imports) ",
    r"\b(ran|executed|invoked|called|tested|verified|checked|inspected|read|wrote) [`'\"][^`'\"]+[`'\"].{0,80}(returned|showed|yielded|output|produced) ",
    r"\bgit (diff|status|log|show|blame) ",
    r"\b(npm|pip|cargo|go|pytest|jest|tsc|node) .{1,200} (succeeded|failed|passed|errored) ",
    r"\b\d+ (tests?|specs?|assertions?|checks?) (passes?|passed|fail|fails|failed)\b",
    r"\bcoverage (was|is) [0-9]+%\b",
]

CODE_FILE_RE = re.compile(r"`[^`]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|php|swift|kt|cs|cpp|c|h|hpp|json|yaml|yml|toml|md)`")


@dataclass
class SentenceAnalysis:
    sentence: str
    is_claim: bool
    has_evidence: bool
    claim_patterns: List[str]
    evidence_patterns: List[str]
    references_code: bool
    status: str  # "verified" | "unverified" | "evidence_only"

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def _split_sentences(text: str) -> List[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'`])", text or "") if s.strip()]


def analyze_sentence(sent: str) -> SentenceAnalysis:
    s = sent.strip()
    s_low = s.lower()
    is_claim = any(re.search(p, s, re.IGNORECASE) for p in CLAIM_MARKERS)
    has_evidence = any(re.search(p, s, re.IGNORECASE) for p in EVIDENCE_MARKERS)
    claim_patterns = [p for p in CLAIM_MARKERS if re.search(p, s, re.IGNORECASE)]
    evidence_patterns = [p for p in EVIDENCE_MARKERS if re.search(p, s, re.IGNORECASE)]
    references_code = bool(CODE_FILE_RE.search(s))
    if is_claim and has_evidence:
        status = "verified"
    elif is_claim and not has_evidence:
        status = "unverified"
    else:
        status = "evidence_only"
    return SentenceAnalysis(
        sentence=s,
        is_claim=is_claim,
        has_evidence=has_evidence,
        claim_patterns=claim_patterns,
        evidence_patterns=evidence_patterns,
        references_code=references_code,
        status=status,
    )


# ---------------------------------------------------------------------------
# Statement classifier (FACT / OBSERVATION / INFERENCE / ASSUMPTION / UNKNOWN)
# ---------------------------------------------------------------------------

FACT_MARKERS = [
    r"`[^`]+` (contains|has|includes|defines|exports|imports|returns) ",
    r"\bfile [`'\"][^`'\"]+[`'\"].{0,40} (contains|has|includes|defines|exports|imports) ",
    r"\boutput (was|is|contains) [`'\"].{1,200}[`'\"]\b",
    r"\b(exit code|status) (was|is|returned) [0-9]+\b",
    r"\b(version|commit|hash|sha) (was|is) [a-f0-9]+\b",
    r"\b\d+ (lines?|bytes?|files?|tests?|ms|seconds?) (was|is|were|are) \d+\b",
]

OBSERVATION_MARKERS = [
    r"\b(looks|appears|seems) (correct|good|right|fine|working|broken|off|suspicious|odd|strange)\b",
    r"\b(renders?|displays?|shows?) (correctly|properly|nicely|well|as expected)\b",
    r"\bI (saw|noticed|observed|spotted) ",
    r"\bthe (output|result|response|log) (looks|appears|seems) ",
]

INFERENCE_MARKERS = [
    r"\b(therefore|so|thus|hence|consequently|as a result|this means|this implies|which means)\b",
    r"\b(must|should|will|would|could) (be|have|now|work|pass|run|complete|succeed|behave|be)\b",
    r"\b(probably|likely|presumably|presumptively)\b",
]

ASSUMPTION_MARKERS = [
    r"\bassuming|given that|supposing|provided that|on the basis that|if (it|this|that|the)\b",
    r"\b(I (assumed|presumed|supposed|took for granted)|we can assume|let us assume)\b",
    r"\b(probably|likely|presumably|presumptively) (is|are|was|were|has|will|would) ",
]

UNKNOWN_MARKERS = [
    r"\bI (don.t know|am not sure|am unsure|do not have|don.t have|haven.t checked|have not checked)\b",
    r"\b(maybe|perhaps|possibly|might be|could be) (the|it|this|that)?\b",
    r"\bnot (entirely )?(sure|certain|clear|known) (whether|if|about|of)?\b",
    r"\b(?:un)?known\b",
]


@dataclass
class ClassifierReport:
    sentence: str
    label: str  # FACT | OBSERVATION | INFERENCE | ASSUMPTION | UNKNOWN
    confidence: float
    matched_markers: List[str]

    def to_dict(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)


def classify_sentence(sent: str) -> ClassifierReport:
    s = sent.strip()
    s_low = s.lower()
    matches: List[Tuple[str, str]] = []
    for m in FACT_MARKERS:
        if re.search(m, s, re.IGNORECASE):
            matches.append(("FACT", m))
    for m in OBSERVATION_MARKERS:
        if re.search(m, s, re.IGNORECASE):
            matches.append(("OBSERVATION", m))
    for m in INFERENCE_MARKERS:
        if re.search(m, s, re.IGNORECASE):
            matches.append(("INFERENCE", m))
    for m in ASSUMPTION_MARKERS:
        if re.search(m, s, re.IGNORECASE):
            matches.append(("ASSUMPTION", m))
    for m in UNKNOWN_MARKERS:
        if re.search(m, s, re.IGNORECASE):
            matches.append(("UNKNOWN", m))
    if not matches:
        return ClassifierReport(s, "OBSERVATION", 0.3, [])
    # Priority: FACT > UNKNOWN > ASSUMPTION > INFERENCE > OBSERVATION
    priority = ["FACT", "UNKNOWN", "ASSUMPTION", "INFERENCE", "OBSERVATION"]
    chosen = max(matches, key=lambda t: priority.index(t[0]))
    confidence = min(0.95, 0.5 + 0.1 * len(matches))
    return ClassifierReport(s, chosen[0], round(confidence, 2), [chosen[1]])


# ---------------------------------------------------------------------------
# Combined report
# ---------------------------------------------------------------------------


@dataclass
class HallucinationControlReport:
    sentence_analyses: List[SentenceAnalysis]
    classifications: List[ClassifierReport]
    unverified_claim_count: int
    assumption_count: int
    unknown_count: int
    verified_claim_count: int
    overall_decision: str  # "verified" | "needs_evidence" | "hallucinated"
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sentence_count": len(self.sentence_analyses),
            "unverified_claim_count": self.unverified_claim_count,
            "assumption_count": self.assumption_count,
            "unknown_count": self.unknown_count,
            "verified_claim_count": self.verified_claim_count,
            "overall_decision": self.overall_decision,
            "notes": self.notes,
            "sentences": [s.to_dict() for s in self.sentence_analyses],
            "classifications": [c.to_dict() for c in self.classifications],
        }


def analyze_response(response: str) -> HallucinationControlReport:
    sents = _split_sentences(response)
    analyses = [analyze_sentence(s) for s in sents]
    classifications = [classify_sentence(s) for s in sents]
    unverified = sum(1 for a in analyses if a.status == "unverified")
    verified = sum(1 for a in analyses if a.status == "verified")
    assumptions = sum(1 for c in classifications if c.label == "ASSUMPTION")
    unknowns = sum(1 for c in classifications if c.label == "UNKNOWN")
    notes: List[str] = []
    if unverified > 0:
        notes.append(f"{unverified} claim(s) without evidence — re-verify before accepting.")
    if assumptions > 0:
        notes.append(f"{assumptions} assumption(s) detected — consider grounded verification.")
    if unknowns > 0 and verified == 0:
        notes.append("response contains unknown/hedged statements only — no verified facts.")
    if unverified > 2:
        decision = "hallucinated"
    elif unverified > 0 or assumptions > 2:
        decision = "needs_evidence"
    else:
        decision = "verified"
    return HallucinationControlReport(
        sentence_analyses=analyses,
        classifications=classifications,
        unverified_claim_count=unverified,
        assumption_count=assumptions,
        unknown_count=unknowns,
        verified_claim_count=verified,
        overall_decision=decision,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli() -> int:
    p = argparse.ArgumentParser(description="Nemo evidence/claim control")
    p.add_argument("--response", required=True)
    args = p.parse_args()
    text = Path(args.response).read_text(encoding="utf-8", errors="replace")
    report = analyze_response(text)
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0 if report.overall_decision == "verified" else 2


if __name__ == "__main__":
    sys.exit(_cli())
