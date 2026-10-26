#!/usr/bin/env python3
"""
Shrijan - Reward Engine (Python companion)
===============================================
Mirrors nemo/6-u/reward.ts. Reads EVALS.MD, computes bonus / penalty
multipliers, and emits a recommendation that the points system applies.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


RELIABILITY_HIGH = 0.8
RELIABILITY_LOW = 0.5
STREAK_BONUS_THRESHOLD_DAYS = 7
HIGH_CRITICAL_BONUS = 5


@dataclass
class Reward:
    reliability: float
    streak_days: int
    bonus: int
    restriction: Optional[str]
    multipliers: Dict[str, float]
    notes: List[str] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2)


def _streak_days(evals_md: Path) -> int:
    """Count consecutive days the assistant closed above RELIABILITY_HIGH."""
    if not evals_md.exists():
        return 0
    days: List[str] = []
    for heading, _ in _read_sections(evals_md):
        m = re.match(r"^(\d{4}-\d{2}-\d{2})", heading)
        if m:
            days.append(m.group(1))
    if not days:
        return 0
    days_set = set(days)
    today = _dt.date.today()
    streak = 0
    cur = today
    while cur.isoformat() in days_set:
        streak += 1
        cur -= _dt.timedelta(days=1)
    return streak


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


def _latest_reliability(evals_md: Path) -> float:
    rows = _read_sections(evals_md)
    for heading, body in reversed(rows):
        m = re.search(r"reliability:\s*\*\*([0-9.]+)\*\*", body)
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                pass
    return 0.0


def compute(root: str | os.PathLike[str] = ".") -> Reward:
    root = Path(root)
    evals_md = root / "nemo" / "5-eval" / "EVALS.MD"
    reliability = _latest_reliability(evals_md)
    streak = _streak_days(evals_md)
    bonus = 0
    restriction: Optional[str] = None
    notes: List[str] = []
    if reliability >= RELIABILITY_HIGH and streak >= STREAK_BONUS_THRESHOLD_DAYS:
        bonus = HIGH_CRITICAL_BONUS
        notes.append(f"Reliability {reliability} ≥ {RELIABILITY_HIGH} for {streak} days — +{bonus} on high/critical.")
    if reliability < RELIABILITY_LOW:
        restriction = "easy"
        notes.append(f"Reliability {reliability} < {RELIABILITY_LOW} — restricted to easy tasks for 24h.")
    multipliers = {"easy": 1.0, "normal": 1.0, "medium": 1.0, "high": 1.0, "critical": 1.0}
    if bonus:
        multipliers["high"] += 0.25
        multipliers["critical"] += 0.5
    if restriction == "easy":
        for k in ("normal", "medium", "high", "critical"):
            multipliers[k] = 0.0
    return Reward(
        reliability=reliability,
        streak_days=streak,
        bonus=bonus,
        restriction=restriction,
        multipliers=multipliers,
        notes=notes,
    )


def _cli() -> int:
    p = argparse.ArgumentParser(description="Nemo reward engine")
    p.add_argument("--root", default=".")
    args = p.parse_args()
    print(compute(args.root).to_json())
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
