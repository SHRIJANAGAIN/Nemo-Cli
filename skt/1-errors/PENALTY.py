#!/usr/bin/env python3
"""
SKT AI LABS - Penalty Engine
============================
Computes the penalty for a mistake based on:
  - base penalty by class
  - 2x multiplier for repeated mistakes within the 24h window
  - escalation tier if the user has explicitly complained

Penalty tiers (per single mistake):
  - syntax / import / type  : 1 point
  - io / permission        : 2 points
  - logic / tool           : 3 points
  - timeout / oom          : 4 points
  - hallucination          : 10 points
  - device                 : 0 points (not the assistant's fault)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


BASE_PENALTIES: Dict[str, int] = {
    "syntax": 1,
    "import": 1,
    "type": 1,
    "io": 2,
    "permission": 2,
    "network": 2,
    "logic": 3,
    "tool": 3,
    "timeout": 4,
    "oom": 4,
    "hallucination": 10,
    "user_error": 0,
    "device": 0,
    "config": 2,
    "unknown": 2,
}

REPEAT_MULTIPLIER = 2
COMPLAINT_MULTIPLIER = 3


@dataclass
class Penalty:
    error_class: str
    base: int
    repeated: bool
    multiplier: int
    total: int
    reason: str

    def to_json(self) -> str:
        return json.dumps(self.__dict__, ensure_ascii=False, indent=2)


def compute(
    error_class: str,
    repeated: bool = False,
    user_complained: bool = False,
) -> Penalty:
    base = BASE_PENALTIES.get(error_class, BASE_PENALTIES["unknown"])
    mult = 1
    reasons: List[str] = []
    if repeated:
        mult *= REPEAT_MULTIPLIER
        reasons.append(f"repeated×{REPEAT_MULTIPLIER}")
    if user_complained:
        mult *= COMPLAINT_MULTIPLIER
        reasons.append(f"user complaint×{COMPLAINT_MULTIPLIER}")
    if base == 0:
        reasons.append("not assistant's fault")
    return Penalty(
        error_class=error_class,
        base=base,
        repeated=repeated,
        multiplier=mult,
        total=base * mult,
        reason=", ".join(reasons) or "no escalation",
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli() -> int:
    p = argparse.ArgumentParser(description="SKT penalty engine")
    p.add_argument("--class", dest="cls", required=True)
    p.add_argument("--repeated", action="store_true")
    p.add_argument("--complained", action="store_true")
    args = p.parse_args()
    pen = compute(args.cls, args.repeated, args.complained)
    print(pen.to_json())
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
