#!/usr/bin/env python3
"""
Shrijan - Improvement Checker
==================================
Cross-checks every assistant response against:
  - HISTORY.MD (past successful tasks)
  - MISTAKES.MD (past mistakes)
  - 2nd-mistake.md (recurring errors)

Emits an accuracy percentage in the local model output and writes a
summary to `HISTORY.MD` when a task is fully successful.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import difflib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")


@dataclass
class CheckResult:
    accuracy: float
    matched_history: List[str]
    matched_mistakes: List[str]
    new_mistakes: List[str]
    improvements: List[str]
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)


def _read_sections(path: Path) -> List[Tuple[str, str]]:
    if not path.exists():
        return []
    out: List[Tuple[str, str]] = []
    cur_h, cur_b = "", []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            if cur_h or cur_b:
                out.append((cur_h, "\n".join(cur_b).strip()))
            cur_h = line[3:].strip()
            cur_b = []
        else:
            cur_b.append(line)
    if cur_h or cur_b:
        out.append((cur_h, "\n".join(cur_b).strip()))
    return out


def _similar(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def check(
    response: str,
    root: str | os.PathLike[str] = ".",
    history_threshold: float = 0.7,
) -> CheckResult:
    root = Path(root)
    history_md = root / "nemo" / "6-u" / "HISTORY.MD"
    mistakes_md = root / "nemo" / "1-errors" / "MISTAKES.MD"
    second_md = root / "nemo" / "1-errors" / "2nd-mistake.md"

    matched_history: List[str] = []
    for heading, body in _read_sections(history_md):
        if not body:
            continue
        if _similar(response[:500], body[:500]) >= history_threshold:
            matched_history.append(heading)

    matched_mistakes: List[str] = []
    for heading, body in _read_sections(mistakes_md):
        if not body:
            continue
        if _similar(response[:500], body[:500]) >= 0.8:
            matched_mistakes.append(heading)

    new_mistakes: List[str] = []
    for heading, body in _read_sections(second_md):
        if not body:
            continue
        if _similar(response[:500], body[:500]) >= 0.8:
            new_mistakes.append(heading)

    improvements: List[str] = []
    for heading, body in _read_sections(root / "nemo" / "1-errors" / "IMPROVEMENT.MD"):
        if not body:
            continue
        if _similar(response[:500], body[:500]) >= 0.7:
            improvements.append(heading)

    total = len(matched_history) + len(matched_mistakes) + len(new_mistakes) + len(improvements)
    accuracy = (len(matched_history) + len(improvements)) / max(1, total)

    notes: List[str] = []
    if matched_history:
        notes.append(f"Echoes {len(matched_history)} past successful tasks — likely on track.")
    if new_mistakes:
        notes.append(f"⚠ {len(new_mistakes)} repeated mistake(s) detected.")
    if not matched_history and not improvements:
        notes.append("No reference found in history — verify correctness independently.")

    return CheckResult(
        accuracy=round(accuracy, 4),
        matched_history=matched_history[:5],
        matched_mistakes=matched_mistakes[:5],
        new_mistakes=new_mistakes[:5],
        improvements=improvements[:5],
        notes=notes,
    )


def _cli() -> int:
    p = argparse.ArgumentParser(description="Nemo improvement checker")
    p.add_argument("--response", required=True, help="path to a file containing the assistant response")
    p.add_argument("--root", default=".")
    args = p.parse_args()
    text = Path(args.response).read_text(encoding="utf-8")
    result = check(text, args.root)
    print(result.to_json())
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
