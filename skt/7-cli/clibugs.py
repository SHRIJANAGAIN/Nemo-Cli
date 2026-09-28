#!/usr/bin/env python3
"""
SKT AI LABS - CLI Bug Auto-Fixer
================================
Mirrors skt/7-cli/clibugs.ts. Scans the trayambak CLI for known runtime
errors (ENOTDIR, ENOENT, EACCES, ECONNRESET) and applies a pre-canned
fix from `CLI.MD`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# Each fix is a (pattern, fix_function) pair.
# The pattern is a regex that matches the error string; the function
# is given (root, error) and returns True on success.

def _fix_enotdir_skt(root: Path, err: str) -> bool:
    """C:\Users\engli\skt exists as a file instead of a directory."""
    home = Path(os.path.expanduser("~"))
    blocker = home / "skt"
    if not blocker.exists() or blocker.is_dir():
        return False
    target = root / "skt"
    if target.exists():
        return True
    try:
        blocker.unlink()
        target.mkdir(parents=True, exist_ok=True)
        return True
    except OSError:
        return False


def _fix_no_dist(root: Path, err: str) -> bool:
    """dist/ missing after a clean checkout — rebuild."""
    if (root / "dist").exists():
        return False
    if not (root / "package.json").exists():
        return False
    res = subprocess.run(["npm", "run", "build"], cwd=str(root), capture_output=True, text=True)
    return res.returncode == 0


def _fix_module_not_found(root: Path, err: str) -> bool:
    """Missing node_modules after a clean clone — reinstall."""
    if (root / "node_modules").exists():
        return False
    if not (root / "package.json").exists():
        return False
    res = subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=str(root), capture_output=True, text=True)
    return res.returncode == 0


def _fix_ts_version_mismatch(root: Path, err: str) -> bool:
    """TypeScript version drift — reinstall dev deps."""
    if "typescript" not in (root / "package.json").read_text(encoding="utf-8", errors="replace"):
        return False
    res = subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=str(root), capture_output=True, text=True)
    return res.returncode == 0


def _fix_econnreset(root: Path, err: str) -> bool:
    """Server connection reset — the local llama-server crashed. Nothing to fix in CLI."""
    return False


FIXES: List[Tuple[re.Pattern[str], Any]] = [
    (re.compile(r"ENOTDIR.*\\skt\\", re.IGNORECASE), _fix_enotdir_skt),
    (re.compile(r"Cannot find module .*dist", re.IGNORECASE), _fix_no_dist),
    (re.compile(r"MODULE_NOT_FOUND", re.IGNORECASE), _fix_module_not_found),
    (re.compile(r"ECONNRESET", re.IGNORECASE), _fix_econnreset),
    (re.compile(r"tsc.*version", re.IGNORECASE), _fix_ts_version_mismatch),
]


@dataclass
class FixResult:
    matched: bool
    fix_name: str
    applied: bool
    detail: str = ""


def autofix(error: str, root: str | os.PathLike[str] = ".") -> FixResult:
    root = Path(root)
    for pat, fn in FIXES:
        if pat.search(error):
            try:
                applied = fn(root, error)
            except Exception as exc:  # noqa: BLE001
                return FixResult(True, fn.__name__, False, f"exception: {exc}")
            return FixResult(True, fn.__name__, applied)
    return FixResult(False, "", False, "no known fix")


def write_cli_md(root: Path, results: List[FixResult]) -> Path:
    out = root / "skt" / "7-cli" / "CLI.MD"
    out.parent.mkdir(parents=True, exist_ok=True)
    if not out.exists():
        out.write_text(
            "# SKT AI LABS — CLI Build History\n\n"
            "Every auto-fix attempt is appended below for audit.\n\n",
            encoding="utf-8",
        )
    with out.open("a", encoding="utf-8", newline="\n") as fp:
        from datetime import datetime, timezone
        fp.write(f"\n## {datetime.now(timezone.utc).isoformat(timespec='seconds')}\n")
        for r in results:
            fp.write(f"- fix: {r.fix_name or '(none)'} | applied: {r.applied} | {r.detail}\n")
    return out


def _cli() -> int:
    p = argparse.ArgumentParser(description="SKT CLI auto-fixer")
    p.add_argument("--error", required=True, help="error string to diagnose")
    p.add_argument("--root", default=".")
    args = p.parse_args()
    r = autofix(args.error, args.root)
    write_cli_md(Path(args.root), [r])
    print(json.dumps(asdict(r), ensure_ascii=False, indent=2))
    return 0 if r.applied or not r.matched else 1


if __name__ == "__main__":
    sys.exit(_cli())
