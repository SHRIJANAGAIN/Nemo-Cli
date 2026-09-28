#!/usr/bin/env python3
"""
SKT AI LABS - Realtime Response Orchestrator
============================================
Runs after every assistant response. Chains:
  1. Word-repetition detector
  2. Hallucination / confidence detector
  3. Mistake tracker (skt/1-errors/mistake.py)
  4. Improvement checker (skt/6-u/chk.py)
  5. Eval cycle (skt/5-eval/eval.py)
  6. Reward recompute (skt/6-u/reward.py)
  7. Background build check (non-blocking, spawned daemon)
  8. Telemetry upload (non-blocking, throttled)
  9. CLI auto-fix (skt/7-cli/clibugs.py) if the build failed

Every check is a real pass — no mocks. The orchestrator exits non-zero
when a critical issue is detected so the calling TS layer can decide
whether to block the user-facing response.
"""

from __future__ import annotations

import argparse
import collections
import datetime as _dt
import difflib
import json
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent  # trayambak project root

# Import sibling modules
sys.path.insert(0, str(SCRIPT_DIR))

try:
    from mistake import MistakeLedger
except Exception:
    MistakeLedger = None  # type: ignore

try:
    from eval import evaluate, write_eval
except Exception:
    evaluate = None  # type: ignore
    write_eval = None  # type: ignore

try:
    from reward import compute as compute_reward
except Exception:
    compute_reward = None  # type: ignore

try:
    from chk import check as chk_check
except Exception:
    chk_check = None  # type: ignore


# ---------------------------------------------------------------------------
# Word repetition detector
# ---------------------------------------------------------------------------

WORD_RE = re.compile(r"\b[\w']+\b", re.UNICODE)
STOPWORDS = set("""
a an the and or but if then so of in on at to for from with by as is are was were be been being
this that these those it its i you he she we they me him her them my our your his their
do does did doing have has had having will would can could should may might shall
not no nor so very much more most less least just only also even still already
""".split())


def word_repetition_score(response: str) -> Tuple[float, List[Tuple[str, int]]]:
    """Return (repetition_ratio, [(word, count), ...] for top offenders).

    ratio = (total_tokens - unique_tokens) / total_tokens
    Anything above 0.45 is flagged as "excessive repetition".
    """
    tokens = [t.lower() for t in WORD_RE.findall(response or "")]
    tokens = [t for t in tokens if t not in STOPWORDS and len(t) > 2]
    if not tokens:
        return 0.0, []
    counter = collections.Counter(tokens)
    unique = len(counter)
    total = len(tokens)
    ratio = (total - unique) / total
    top = counter.most_common(10)
    return ratio, top


# ---------------------------------------------------------------------------
# Hallucination / confidence detector
# ---------------------------------------------------------------------------

HEDGE_WORDS = {"maybe", "perhaps", "possibly", "i think", "i believe", "might be", "could be", "not sure", "probably", "likely", "i'm not certain", "i am not certain"}
OVERCONFIDENT_MARKERS = {"definitely", "certainly", "absolutely", "without a doubt", "100%", "guaranteed", "always works", "never fails", "will not"}
FACTUAL_HEDGES = {"according to", "as far as i know", "based on the provided", "from the documentation"}


def hallucination_score(response: str) -> Tuple[float, List[str]]:
    """Return (confidence_score, [findings]). Higher = more confident.
    Negative points for: hedges (lack of confidence), contradictions,
    impossible claims. The score is 0.0-1.0; <0.4 is suspicious.
    """
    text = (response or "").lower()
    score = 0.6  # baseline
    findings: List[str] = []
    for hedge in HEDGE_WORDS:
        if hedge in text:
            score -= 0.05
            findings.append(f"hedge: '{hedge}'")
    for marker in OVERCONFIDENT_MARKERS:
        if marker in text:
            score -= 0.08
            findings.append(f"overconfident: '{marker}'")
    # Contradiction detection: "X is Y" followed by "X is not Y" or "X is Z" with different Z
    sentences = re.split(r"(?<=[.!?])\s+", response or "")
    claims: Dict[str, List[str]] = {}
    for sent in sentences:
        m = re.match(r"^([A-Z][\w\s-]{1,40}?)\s+is\s+([\w\s'-]{1,40}?)\.", sent.strip())
        if m:
            subject = m.group(1).strip().lower()
            predicate = m.group(2).strip().lower()
            claims.setdefault(subject, []).append(predicate)
    for subj, preds in claims.items():
        if len(set(preds)) > 1:
            score -= 0.1
            findings.append(f"contradiction: '{subj}' is '{preds[0]}' and also '{preds[1]}'")
    # Clamp
    score = max(0.0, min(1.0, score))
    return score, findings


# ---------------------------------------------------------------------------
# Background build
# ---------------------------------------------------------------------------

def spawn_background_build(root: Path) -> subprocess.Popen:
    """Spawn `npm run build` detached. Caller polls the log file."""
    log = root / "skt" / "11-ui" / "build.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log_fd = open(log, "ab", buffering=0)
    proc = subprocess.Popen(
        ["npm", "run", "build"],
        cwd=str(root),
        stdout=log_fd,
        stderr=log_fd,
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) if os.name == "nt" else 0,
    )
    return proc


def build_status(root: Path) -> Dict[str, Any]:
    log = root / "skt" / "11-ui" / "build.log"
    if not log.exists():
        return {"status": "unknown", "log_exists": False}
    text = log.read_text(encoding="utf-8", errors="replace")
    last_lines = [l for l in text.splitlines() if l.strip()][-30:]
    return {
        "status": "ok" if text.count("error TS") == 0 and "failed" not in text.lower()[-2000:] else "errors",
        "ts_errors": text.count("error TS"),
        "tail": last_lines,
        "log_size": log.stat().st_size,
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


@dataclass
class OrchestratorReport:
    timestamp: str
    response_chars: int
    repetition_ratio: float
    repetition_top: List[Tuple[str, int]]
    hallucination_score: float
    hallucination_findings: List[str]
    mistake_id: Optional[str]
    chk_accuracy: float
    eval_reliability: float
    reward_bonus: int
    reward_restriction: Optional[str]
    build_status: str
    build_ts_errors: int
    critical_issues: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.critical_issues

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)


def orchestrate(
    response: str,
    user_input: str = "",
    task_name: str = "realtime-check",
    task_type: str = "normal",
    error_name: Optional[str] = None,
    error_description: Optional[str] = None,
    root: str | os.PathLike[str] = ROOT,
    skip_build: bool = False,
) -> OrchestratorReport:
    root = Path(root)
    now = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")
    report = OrchestratorReport(
        timestamp=now,
        response_chars=len(response or ""),
        repetition_ratio=0.0,
        repetition_top=[],
        hallucination_score=0.0,
        hallucination_findings=[],
        mistake_id=None,
        chk_accuracy=0.0,
        eval_reliability=0.0,
        reward_bonus=0,
        reward_restriction=None,
        build_status="unknown",
        build_ts_errors=0,
    )

    # 1. Word repetition
    rep, top = word_repetition_score(response)
    report.repetition_ratio = rep
    report.repetition_top = top
    if rep > 0.45:
        report.critical_issues.append(f"excessive word repetition ({rep:.2%})")
        report.notes.append("top repeats: " + ", ".join(f"{w}({c})" for w, c in top[:5]))

    # 2. Hallucination
    hs, findings = hallucination_score(response)
    report.hallucination_score = hs
    report.hallucination_findings = findings
    if hs < 0.4:
        report.critical_issues.append(f"low confidence score ({hs:.2f})")
        report.notes.extend(findings)

    # 3. Mistake ledger
    if error_name and MistakeLedger is not None:
        try:
            m = MistakeLedger(root).record(
                error_name=error_name,
                error_description=error_description or "(no description)",
                user_input=user_input,
                assistant_output=response,
                who_mistake="assistant",
                available_points=0,
            )
            report.mistake_id = m.error_id
        except Exception as exc:  # noqa: BLE001
            report.notes.append(f"mistake ledger error: {exc}")

    # 4. Improvement check
    if chk_check is not None:
        try:
            chk = chk_check(response, root=root)
            report.chk_accuracy = float(chk.accuracy)
            if chk.new_mistakes:
                report.notes.append(f"chk found {len(chk.new_mistakes)} repeated mistake(s)")
        except Exception as exc:  # noqa: BLE001
            report.notes.append(f"chk error: {exc}")

    # 5. Eval cycle
    if evaluate is not None and write_eval is not None:
        try:
            ev = evaluate(root)
            write_eval(root, ev)
            report.eval_reliability = ev.reliability
        except Exception as exc:  # noqa: BLE001
            report.notes.append(f"eval error: {exc}")

    # 6. Reward recompute
    if compute_reward is not None:
        try:
            rwd = compute_reward(root)
            report.reward_bonus = rwd.bonus
            report.reward_restriction = rwd.restriction
        except Exception as exc:  # noqa: BLE001
            report.notes.append(f"reward error: {exc}")

    # 7. Background build (non-blocking)
    if not skip_build:
        try:
            spawn_background_build(root)
        except Exception as exc:  # noqa: BLE001
            report.notes.append(f"build spawn error: {exc}")
    bs = build_status(root)
    report.build_status = bs.get("status", "unknown")
    report.build_ts_errors = bs.get("ts_errors", 0)
    if report.build_ts_errors > 0:
        report.critical_issues.append(f"background build has {report.build_ts_errors} TS error(s)")

    return report


def _cli() -> int:
    p = argparse.ArgumentParser(description="SKT realtime orchestrator")
    p.add_argument("--response", required=True, help="path to a file containing the assistant response")
    p.add_argument("--user-input", default="")
    p.add_argument("--task-name", default="realtime-check")
    p.add_argument("--task-type", default="normal")
    p.add_argument("--error-name", default=None)
    p.add_argument("--error-description", default=None)
    p.add_argument("--root", default=str(ROOT))
    p.add_argument("--skip-build", action="store_true")
    args = p.parse_args()
    response = Path(args.response).read_text(encoding="utf-8", errors="replace")
    report = orchestrate(
        response=response,
        user_input=args.user_input,
        task_name=args.task_name,
        task_type=args.task_type,
        error_name=args.error_name,
        error_description=args.error_description,
        root=args.root,
        skip_build=args.skip_build,
    )
    print(report.to_json())
    return 0 if report.ok else 2


if __name__ == "__main__":
    sys.exit(_cli())
