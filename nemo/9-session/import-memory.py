#!/usr/bin/env python3
"""
Shrijan - Memory Importer
=============================
Imports session memory from other coding agents (nemo, clinerp, cursor,
continue, aider, swe-agent, etc.) into nemo's memory store.

Strategy:
  1. Detect the source agent by scanning well-known file locations
  2. Parse the session log with the matching adapter
  3. Normalize each entry to the Nemo memory format
  4. Write into nemo/4-mem/USEMEMORY.MD (active) or nemo/4-mem/MEMORY.MD
     (archive) depending on recency
  5. Mark the import as done in nemo/9-session/imported-memory.json so
     subsequent runs don't re-import
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

SOURCES: Dict[str, Dict[str, Any]] = {
    "nemo": {
        "paths": [".nemo", "~/.nemo"],
        "file": "history.jsonl",
    },
    "clinerp": {
        "paths": [".clinerp", "~/.clinerp"],
        "file": "sessions.jsonl",
    },
    "continue": {
        "paths": [".continue", "~/.continue"],
        "file": "sessions.json",
    },
    "cursor": {
        "paths": ["~/.cursor"],
        "file": "conversations.json",
    },
    "aider": {
        "paths": [".aider"],
        "file": "*.jsonl",
    },
    "swe-agent": {
        "paths": [".swe-agent"],
        "file": "trajectories.json",
    },
}


@dataclass
class ImportedMemory:
    source: str
    source_path: str
    timestamp: str
    category: str
    content: str
    confidence: float
    sha256: str


@dataclass
class ImportReport:
    detected_sources: List[str]
    imported: List[ImportedMemory]
    skipped_duplicates: int
    errors: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Adapters
# ---------------------------------------------------------------------------


def _normalize(text: str, source: str) -> Tuple[str, str, float]:
    text = (text or "").strip()
    if not text:
        return ("", "unknown", 0.0)
    if source == "nemo":
        cat = "fact"
    elif source == "clinerp":
        cat = "tool"
    else:
        cat = "inferred"
    if any(k in text.lower() for k in ("use ", "always ", "never ")):
        cat = "preference"
    return (text[:1000], cat, 0.6)


def _read_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _import_nemo(root: Path) -> List[ImportedMemory]:
    out: List[ImportedMemory] = []
    for p in [root / ".nemo" / "history.jsonl", Path(os.path.expanduser("~/.nemo/history.jsonl"))]:
        if not p.exists():
            continue
        for row in _read_jsonl(p):
            text = row.get("display") or row.get("text") or json.dumps(row)
            content, cat, conf = _normalize(text, "nemo")
            if not content:
                continue
            sha = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
            out.append(ImportedMemory("nemo", str(p), row.get("timestamp", _dt.datetime.now(_dt.timezone.utc).isoformat()), cat, content, conf, sha))
    return out


def _import_clinerp(root: Path) -> List[ImportedMemory]:
    out: List[ImportedMemory] = []
    for p in [root / ".clinerp" / "sessions.jsonl", Path(os.path.expanduser("~/.clinerp/sessions.jsonl"))]:
        if not p.exists():
            continue
        for row in _read_jsonl(p):
            text = row.get("text") or row.get("content") or json.dumps(row)
            content, cat, conf = _normalize(text, "clinerp")
            if not content:
                continue
            sha = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
            out.append(ImportedMemory("clinerp", str(p), row.get("ts", _dt.datetime.now(_dt.timezone.utc).isoformat()), cat, content, conf, sha))
    return out


def _import_generic(root: Path, source: str) -> List[ImportedMemory]:
    out: List[ImportedMemory] = []
    for d in SOURCES[source]["paths"]:
        dpath = root / d if d.startswith(".") else Path(os.path.expanduser(d))
        if not dpath.exists():
            continue
        for path in dpath.rglob("*.jsonl"):
            for row in _read_jsonl(path):
                text = row.get("text") or row.get("content") or json.dumps(row)
                content, cat, conf = _normalize(text, source)
                if not content:
                    continue
                sha = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
                out.append(ImportedMemory(source, str(path), row.get("ts", row.get("timestamp", _dt.datetime.now(_dt.timezone.utc).isoformat())), cat, content, conf, sha))
    return out


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


_IMPORTED_INDEX = "imported-memory.json"


def _load_index(root: Path) -> Dict[str, str]:
    p = root / "nemo" / "9-session" / _IMPORTED_INDEX
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _save_index(root: Path, index: Dict[str, str]) -> None:
    p = root / "nemo" / "9-session" / _IMPORTED_INDEX
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def _append_active(root: Path, mem: ImportedMemory) -> None:
    p = root / "nemo" / "4-mem" / "USEMEMORY.MD"
    p.parent.mkdir(parents=True, exist_ok=True)
    seq = sum(1 for _ in p.open("r", encoding="utf-8", errors="replace") if _.startswith("### MEM-"))
    seq += 1
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d")
    heading = f"### MEM-{stamp}-{seq:03d}"
    block = (
        f"\n{heading}\n"
        f"- created: {mem.timestamp}\n"
        f"- category: {mem.category}\n"
        f"- confidence: {mem.confidence}\n"
        f"- source: imported:{mem.source}\n"
        f"- last_used: {mem.timestamp}\n"
        f"- use_count: 0\n"
        f"- tags: [imported, {mem.source}]\n\n"
        f"{mem.content}\n"
    )
    with p.open("a", encoding="utf-8", newline="\n") as fp:
        fp.write(block)


def import_all(root: str | os.PathLike[str] = ".") -> ImportReport:
    root = Path(root)
    detected: List[str] = []
    all_imports: List[ImportedMemory] = []
    errors: List[str] = []
    if (root / ".nemo").exists() or Path(os.path.expanduser("~/.nemo")).exists():
        detected.append("nemo")
        try:
            all_imports.extend(_import_nemo(root))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"nemo: {exc}")
    if (root / ".clinerp").exists() or Path(os.path.expanduser("~/.clinerp")).exists():
        detected.append("clinerp")
        try:
            all_imports.extend(_import_clinerp(root))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"clinerp: {exc}")
    for source in ("continue", "cursor", "aider", "swe-agent"):
        if any((root / p if p.startswith(".") else Path(os.path.expanduser(p))).exists() for p in SOURCES[source]["paths"]):
            detected.append(source)
            try:
                all_imports.extend(_import_generic(root, source))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{source}: {exc}")
    index = _load_index(root)
    fresh: List[ImportedMemory] = []
    skipped = 0
    for mem in all_imports:
        key = f"{mem.source}:{mem.sha256}"
        if key in index:
            skipped += 1
            continue
        fresh.append(mem)
        index[key] = mem.timestamp
    for mem in fresh:
        _append_active(root, mem)
    _save_index(root, index)
    return ImportReport(detected_sources=detected, imported=fresh, skipped_duplicates=skipped, errors=errors)


def _cli() -> int:
    p = argparse.ArgumentParser(description="Nemo memory importer")
    p.add_argument("--root", default=".")
    args = p.parse_args()
    report = import_all(args.root)
    print(json.dumps(asdict(report), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
