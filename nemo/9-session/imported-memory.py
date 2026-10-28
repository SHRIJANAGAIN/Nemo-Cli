#!/usr/bin/env python3
"""
Shrijan - Import Verification
=================================
Verifies that the memory import actually wrote entries to USEMEMORY.MD.
If the import subprocess reported success but no entries landed (or
fewer than expected), re-runs the importer.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict


def _count_entries(usememory_md: Path) -> int:
    if not usememory_md.exists():
        return 0
    return sum(1 for line in usememory_md.read_text(encoding="utf-8", errors="replace").splitlines() if line.startswith("### MEM-"))


def verify(root: str | os.PathLike[str] = ".") -> Dict[str, Any]:
    root = Path(root)
    usememory = root / "nemo" / "4-mem" / "USEMEMORY.MD"
    before = _count_entries(usememory)
    py = Path(__file__).parent / "import-memory.py"
    res = subprocess.run([sys.executable, str(py), "--root", str(root)], capture_output=True, text=True)
    after = _count_entries(usememory)
    out = {
        "before": before,
        "after": after,
        "delta": after - before,
        "importer_stdout_tail": (res.stdout or "")[-400:],
        "importer_stderr_tail": (res.stderr or "")[-400:],
        "importer_returncode": res.returncode,
    }
    if after <= before:
        # retry once
        res = subprocess.run([sys.executable, str(py), "--root", str(root)], capture_output=True, text=True)
        out["retry_returncode"] = res.returncode
        out["after_retry"] = _count_entries(usememory)
    return out


def _cli() -> int:
    p = argparse.ArgumentParser(description="Nemo import verifier")
    p.add_argument("--root", default=".")
    args = p.parse_args()
    print(json.dumps(verify(args.root), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
