#!/usr/bin/env python3
"""
SKT AI LABS - Streaming Generation Gate
=======================================
Runs repetition and claim/evidence checks on the live token stream.
Designed to be called once per token delta (or every N tokens for
performance) and decides whether to:

  - "continue"  — keep generating
  - "cut"       — stop here, keep the text up to the cut point
  - "retry"     — stop, drop the text, ask the runtime to retry with a
                  different prompt and higher temperature

The gate never just stops silently — it always marks GENERATION_FAILURE
and records the reason so the retry prompt can be informed.

Streaming checks implemented:
  L1s — consecutive-token run (fires after 8+ identical tokens in a row)
  L2s — recent-window n-gram repetition (looks at the last 200 tokens)
  L3s — sentence-level repetition (triggers on every new sentence)
  CEs  — claim-without-evidence (increments on every new sentence)
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

WORD_RE = re.compile(r"\b[\w']+\b", re.UNICODE)
SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'`])")
STOPWORDS = set("""
a an the and or but if then so of in on at to for from with by as is are was were be been being
this that these those it its i you he she we they me him her them my our your his their
do does did doing have has had having will would can could should may might shall
not no nor very much more most less least just only also even still already
""".split())


CLAIM_MARKERS = [
    r"\bI (fixed|solved|resolved|completed|implemented|added|removed|updated|patched|created|wrote|built|ran|tested|verified|optimized|refactored|merged|deployed|installed|configured)\b",
    r"\bThe (code|function|method|class|module|file|build|test|server|client|api|route|endpoint|fix|bug|issue|error|feature|component|system)\b.{0,80}\b(is|was|are|now|works?|working|fixed|set|ready|complete)\b",
    r"\bThis (fixes|solves|resolves|implements|adds|removes|updates|handles)\b",
    r"\b(should|will|now) (work|pass|build|run|compile|succeed|complete)\b",
]
EVIDENCE_MARKERS = [
    r"\bexit code [0-9]+\b",
    r"\b\d+ (tests?|specs?|assertions?) (passes?|passed|fails?|failed)\b",
    r"\b(npm|pip|tsc|cargo|go test) .{0,200} (succeeded|failed|passed)\b",
    r"\bfile [`'\"][^`'\"]+[`'\"].{0,40}(contains|has|defines|exports|imports) ",
    r"`[^`]+\.(ts|js|py|go|rs|json|md)`.{0,80}(contains|has|defines|exports|imports) ",
    r"\bgit (diff|status|log|show) ",
    r"\bcoverage (was|is) [0-9]+%\b",
]


def _tokens(text: str) -> List[str]:
    return [m.group(0).lower() for m in WORD_RE.finditer(text or "")]


def _is_claim(s: str) -> bool:
    return any(re.search(p, s, re.IGNORECASE) for p in CLAIM_MARKERS)


def _has_evidence(s: str) -> bool:
    return any(re.search(p, s, re.IGNORECASE) for p in EVIDENCE_MARKERS)


def _split_sentences(text: str) -> List[str]:
    return [s.strip() for s in SENTENCE_END_RE.split(text or "") if s.strip()]


# ---------------------------------------------------------------------------
# Streaming gate
# ---------------------------------------------------------------------------


@dataclass
class GateDecision:
    decision: str  # "continue" | "cut" | "retry"
    reason: str
    level: str
    cut_at_char: int
    char_pos: int
    total_chars: int
    details: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "decision": self.decision,
            "reason": self.reason,
            "level": self.level,
            "cut_at_char": self.cut_at_char,
            "char_pos": self.char_pos,
            "total_chars": self.total_chars,
            "details": self.details,
        }


class StreamingGate:
    """Stateful gate. Call `ingest(delta)` for every token, then `finalize()`.

    The gate buffers text, watches for the streaming triggers, and
    returns a decision when one fires.
    """

    def __init__(
        self,
        consecutive_run_threshold: int = 8,
        ngram_repeat_threshold: int = 4,
        ngram_history: int = 200,
        sentence_min_occurrences: int = 2,
        unverified_claim_threshold: int = 2,
    ) -> None:
        self.consecutive_run_threshold = consecutive_run_threshold
        self.ngram_repeat_threshold = ngram_repeat_threshold
        self.ngram_history = ngram_history
        self.sentence_min_occurrences = sentence_min_occurrences
        self.unverified_claim_threshold = unverified_claim_threshold
        self.buffer = ""
        self.last_token: Optional[str] = None
        self.run_length = 0
        self.token_window: Deque[str] = collections.deque(maxlen=ngram_history)
        self.sentences: List[str] = []
        self.unverified_claim_count = 0
        self.last_decision: Optional[GateDecision] = None
        self.decision_made = False

    def ingest(self, delta: str) -> Optional[GateDecision]:
        """Feed a chunk of new text. Returns a decision if one fires."""
        if self.decision_made or not delta:
            return None
        self.buffer += delta
        # Update consecutive run on per-token basis
        for tok in re.findall(r"[\w']+|[^\w\s]", delta):
            if re.match(r"\w", tok):
                tl = tok.lower()
                if self.last_token == tl:
                    self.run_length += 1
                else:
                    self.last_token = tl
                    self.run_length = 1
                self.token_window.append(tl)
                if self.run_length >= self.consecutive_run_threshold:
                    return self._fire(
                        "retry",
                        "L1s_consecutive_run",
                        f"token '{tl}' repeated {self.run_length} times in a row",
                        char_pos=len(self.buffer),
                        details={"token": tl, "run_length": self.run_length},
                    )
        # N-gram check: look at 4-gram repeats in the recent window
        if len(self.token_window) >= 4:
            tokens = list(self.token_window)
            recent = [t for t in tokens[-self.ngram_history:] if t not in STOPWORDS and len(t) > 1]
            if len(recent) >= 4:
                grams = [tuple(recent[i:i + 4]) for i in range(len(recent) - 3)]
                counter = collections.Counter(grams)
                most = counter.most_common(1)[0]
                if most[1] >= self.ngram_repeat_threshold:
                    return self._fire(
                        "retry",
                        "L2s_ngram_repeat",
                        f"4-gram repeated {most[1]} times",
                        char_pos=len(self.buffer),
                        details={"ngram": " ".join(most[0]), "count": most[1]},
                    )
        # Sentence-level checks: when a new sentence just completed
        if re.search(r"[.!?][\s]*$", delta) or "\n\n" in delta:
            sentences = _split_sentences(self.buffer)
            if len(sentences) > len(self.sentences):
                new_sents = sentences[len(self.sentences):]
                for s in new_sents:
                    if _is_claim(s) and not _has_evidence(s):
                        self.unverified_claim_count += 1
                # Sentence repetition
                norm_sentences = [
                    " ".join(_tokens(s)).lower() for s in sentences
                ]
                counter = collections.Counter(norm_sentences)
                most = counter.most_common(1)[0]
                if most[1] >= self.sentence_min_occurrences and len(most[0]) > 10:
                    # Cut at the second occurrence
                    target = most[0]
                    for i, ns in enumerate(norm_sentences):
                        if ns == target and i > 0:
                            cut_at = self.buffer.find(sentences[i])
                            if cut_at < 0:
                                cut_at = len(self.buffer)
                            return self._fire(
                                "cut",
                                "L3s_sentence_repeat",
                                f"sentence repeated {most[1]} times",
                                char_pos=len(self.buffer),
                                cut_at=cut_at,
                                details={"sentence": sentences[i][:200], "count": most[1]},
                            )
                if self.unverified_claim_count >= self.unverified_claim_threshold:
                    return self._fire(
                        "cut",
                        "CEs_unverified_claim",
                        f"{self.unverified_claim_count} claim(s) without evidence",
                        char_pos=len(self.buffer),
                        cut_at=len(self.buffer) - len(new_sents[-1]) if new_sents else len(self.buffer),
                        details={"unverified_claim_count": self.unverified_claim_count},
                    )
                self.sentences = sentences
        return None

    def _fire(
        self,
        decision: str,
        level: str,
        reason: str,
        char_pos: int,
        cut_at: Optional[int] = None,
        details: Optional[Dict[str, Any]] = None,
    ) -> GateDecision:
        d = GateDecision(
            decision=decision,
            reason=reason,
            level=level,
            cut_at_char=cut_at if cut_at is not None else char_pos,
            char_pos=char_pos,
            total_chars=len(self.buffer),
            details=details or {},
        )
        self.last_decision = d
        self.decision_made = True
        return d

    def finalize(self) -> Optional[GateDecision]:
        if self.decision_made:
            return self.last_decision
        return None


# ---------------------------------------------------------------------------
# Execution verification pipeline
# ---------------------------------------------------------------------------


@dataclass
class VerificationStep:
    name: str
    command: str
    status: str  # "pass" | "fail" | "skip" | "error"
    duration_ms: int
    output_tail: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "command": self.command,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "output_tail": self.output_tail[:300],
        }


@dataclass
class VerificationReport:
    steps: List[VerificationStep]
    overall: str  # "pass" | "fail"
    duration_ms: int

    def to_dict(self) -> Dict[str, Any]:
        return {
            "steps": [s.to_dict() for s in self.steps],
            "overall": self.overall,
            "duration_ms": self.duration_ms,
        }


def run_step(name: str, command: List[str], cwd: Path, timeout_s: int = 60) -> VerificationStep:
    import shutil
    import subprocess
    import time
    start = time.monotonic()
    # Resolve the executable so Windows .cmd/.bat shims (npm, npx) are found.
    exe = shutil.which(command[0]) or command[0]
    resolved = [exe, *command[1:]]
    try:
        res = subprocess.run(
            resolved,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            shell=False,
        )
        duration = int((time.monotonic() - start) * 1000)
        out = (res.stdout or "") + (res.stderr or "")
        if res.returncode == 0:
            status = "pass"
        elif "Missing script" in out or "missing script" in out.lower():
            status = "skip"
        else:
            status = "fail"
        return VerificationStep(name, " ".join(command), status, duration, out[-500:])
    except subprocess.TimeoutExpired:
        duration = int((time.monotonic() - start) * 1000)
        return VerificationStep(name, " ".join(command), "error", duration, "timeout")
    except FileNotFoundError as exc:
        return VerificationStep(name, " ".join(command), "skip", 0, str(exc))
    except Exception as exc:  # noqa: BLE001
        return VerificationStep(name, " ".join(command), "error", 0, str(exc))


def run_verification_pipeline(
    cwd: str | os.PathLike[str] = ".",
    skip_tests: bool = False,
    skip_runtime: bool = True,
) -> VerificationReport:
    """Run: LINT → TYPECHECK → TEST → BUILD → (optional RUNTIME)."""
    import os
    import time
    cwd = Path(cwd)
    steps: List[VerificationStep] = []
    start = time.monotonic()
    # LINT
    if (cwd / "package.json").exists():
        steps.append(run_step("lint", ["npm", "run", "lint"], cwd))
    else:
        steps.append(VerificationStep("lint", "n/a", "skip", 0, "no package.json"))
    # TYPECHECK
    if (cwd / "tsconfig.json").exists():
        steps.append(run_step("typecheck", ["npx", "tsc", "--noEmit"], cwd))
    else:
        steps.append(VerificationStep("typecheck", "n/a", "skip", 0, "no tsconfig.json"))
    # TESTS
    if not skip_tests and (cwd / "package.json").exists():
        steps.append(run_step("test", ["npm", "test", "--silent"], cwd, timeout_s=120))
    # BUILD
    if (cwd / "package.json").exists():
        steps.append(run_step("build", ["npm", "run", "build"], cwd, timeout_s=180))
    # RUNTIME — optional smoke test
    if not skip_runtime:
        steps.append(VerificationStep("runtime", "n/a", "skip", 0, "no runtime test configured"))
    duration = int((time.monotonic() - start) * 1000)
    executed = [s for s in steps if s.status != "skip"]
    if not executed:
        overall = "skip"
    elif any(s.status in ("fail", "error") for s in steps):
        overall = "fail"
    else:
        overall = "pass"
    return VerificationReport(steps=steps, overall=overall, duration_ms=duration)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli_stream() -> int:
    p = argparse.ArgumentParser(description="SKT streaming gate")
    sub = p.add_subparsers(dest="cmd")
    ps = sub.add_parser("stream", help="test the gate on a response")
    ps.add_argument("--response", required=True)
    ps.add_argument("--consecutive-run", type=int, default=8)
    ps.add_argument("--ngram-repeat", type=int, default=4)
    ps.add_argument("--sentence-min", type=int, default=2)
    ps.add_argument("--unverified-claim-threshold", type=int, default=2)
    pv = sub.add_parser("verify", help="run the verification pipeline")
    pv.add_argument("--cwd", default=".")
    pv.add_argument("--skip-tests", action="store_true")
    args = p.parse_args()
    if args.cmd == "stream":
        text = Path(args.response).read_text(encoding="utf-8", errors="replace")
        gate = StreamingGate(
            consecutive_run_threshold=args.consecutive_run,
            ngram_repeat_threshold=args.ngram_repeat,
            sentence_min_occurrences=args.sentence_min,
            unverified_claim_threshold=args.unverified_claim_threshold,
        )
        decision = None
        # Stream in small chunks
        for i in range(0, len(text), 4):
            d = gate.ingest(text[i:i + 4])
            if d:
                decision = d
                break
        if decision is None:
            decision = gate.finalize()
        print(json.dumps(decision.to_dict() if decision else {"decision": "continue"}, ensure_ascii=False, indent=2))
        return 0 if (decision is None or decision.decision == "continue") else 2
    if args.cmd == "verify":
        report = run_verification_pipeline(args.cwd, skip_tests=args.skip_tests)
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
        return 0 if report.overall == "pass" else 1
    p.print_help()
    return 1


def _daemon_loop() -> int:
    """Stdin/stdout protocol for the TS streaming gate.

    Commands (one per line, JSON):
      {"op":"init","consecutive_run":8,"ngram_repeat":4,"sentence_min":2,"unverified_claim":2}
      {"op":"ingest","delta":"..."}
      {"op":"finalize"}
      {"op":"reset"}
      {"op":"verify","cwd":"...","skip_tests":false}
      {"op":"quit"}
    Responses are JSON objects, one per line.
    """
    gate: Optional[StreamingGate] = None
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(json.dumps({"op": "error", "error": f"bad json: {exc}"}) + "\n")
            sys.stdout.flush()
            continue
        op = msg.get("op")
        if op == "init":
            gate = StreamingGate(
                consecutive_run_threshold=int(msg.get("consecutive_run", 8)),
                ngram_repeat_threshold=int(msg.get("ngram_repeat", 4)),
                sentence_min_occurrences=int(msg.get("sentence_min", 2)),
                unverified_claim_threshold=int(msg.get("unverified_claim", 2)),
            )
            sys.stdout.write(json.dumps({"op": "init", "ok": True}) + "\n")
        elif op == "ingest":
            assert gate is not None, "gate not initialized"
            d = gate.ingest(str(msg.get("delta", "")))
            sys.stdout.write(json.dumps({"op": "ingest", "decision": d.to_dict() if d else {"decision": "continue"}}) + "\n")
        elif op == "finalize":
            assert gate is not None
            d = gate.finalize()
            sys.stdout.write(json.dumps({"op": "finalize", "decision": d.to_dict() if d else {"decision": "continue"}}) + "\n")
        elif op == "reset":
            gate = None
            sys.stdout.write(json.dumps({"op": "reset", "ok": True}) + "\n")
        elif op == "verify":
            report = run_verification_pipeline(
                msg.get("cwd", "."),
                skip_tests=bool(msg.get("skip_tests", False)),
            )
            sys.stdout.write(json.dumps({"op": "verify", "report": report.to_dict()}) + "\n")
        elif op == "quit":
            sys.stdout.write(json.dumps({"op": "quit", "ok": True}) + "\n")
            sys.stdout.flush()
            return 0
        else:
            sys.stdout.write(json.dumps({"op": "error", "error": f"unknown op {op!r}"}) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        sys.exit(_daemon_loop())
    sys.exit(_cli_stream())
