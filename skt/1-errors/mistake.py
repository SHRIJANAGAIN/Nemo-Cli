#!/usr/bin/env python3
"""
SKT AI LABS - Mistake Tracker
=============================
Mirrors skt/1-errors/mistake.ts.

Records every error/mistake the assistant makes, with full context
(user input, assistant output, token usage, root cause analysis, and
resolution status). The 2nd-mistake detector applies a 2x penalty when
the same error class recurs within a sliding window.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import difflib
import json
import os
import re
import sys
import threading
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

MISTAKE_CLASSES = [
    "syntax",
    "import",
    "type",
    "logic",
    "io",
    "permission",
    "network",
    "timeout",
    "oom",
    "tool",
    "hallucination",
    "user_error",
    "device",
    "config",
    "unknown",
]

CAUSE_OPTIONS = [
    "assistant",
    "user",
    "device",
    "environment",
    "tool",
    "model",
    "network",
    "unknown",
]

WINDOW_SECONDS = 24 * 60 * 60  # 2nd-mistake window
SECOND_MISTAKE_MULTIPLIER = 2

MAX_TEXT = 16000
TOKEN_RE = re.compile(r"\S+")


def _count_tokens(text: str) -> int:
    return len(TOKEN_RE.findall(text or ""))


@dataclass
class Mistake:
    """A single recorded mistake."""

    error_id: str
    error_name: str
    error_class: str
    error_description: str
    error_paragraph: str
    timestamp: str
    user_input: str
    assistant_output: str
    tokens_consumed: int
    why_assistant_did_it: str
    reason_held: str
    who_mistake: str
    is_device_error: bool
    how_to_resolve: str
    is_fixed: bool
    future_prevention: str
    repeated: bool
    available_points: int
    session_id: str = ""
    resolved_at: str = ""
    penalty_points: int = 0

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @staticmethod
    def from_jsonl(line: str) -> "Mistake":
        return Mistake(**json.loads(line))


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


class _FileLock:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def __enter__(self) -> None:
        self._lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        self.fp = open(self._lock_path, "w", encoding="utf-8")
        # best-effort advisory lock; on Windows this is best-effort
        try:
            if hasattr(os, "lockf"):
                os.lockf(self.fp.fileno(), os.F_LOCK, 0)
        except OSError:
            pass

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if hasattr(os, "lockf"):
                os.lockf(self.fp.fileno(), os.F_ULOCK, 0)
        except OSError:
            pass
        try:
            self.fp.close()
        except Exception:
            pass
        try:
            self._lock_path.unlink()
        except FileNotFoundError:
            pass


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")


def _classify(text: str) -> str:
    s = (text or "").lower()
    if "syntaxerror" in s or re.search(r"unexpected token", s):
        return "syntax"
    if "modulenotfounderror" in s or "cannot find module" in s:
        return "import"
    if "typeerror" in s or "is not assignable" in s:
        return "type"
    if "eacces" in s or "permission" in s:
        return "permission"
    if "econnrefused" in s or "enotfound" in s or "etimedout" in s or "network" in s:
        return "network"
    if "timeout" in s:
        return "timeout"
    if "out of memory" in s or "enomem" in s:
        return "oom"
    if "enoent" in s:
        return "io"
    if "tool" in s and "fail" in s:
        return "tool"
    return "unknown"


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------


class MistakeLedger:
    def __init__(self, root: str | os.PathLike[str] = ".") -> None:
        self.root = Path(root)
        self.dir = self.root / "skt" / "1-errors"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.jsonl = self.dir / "mistakes.jsonl"
        self.md = self.dir / "MISTAKES.MD"
        self.second_md = self.dir / "2nd-mistake.md"
        self.improvement_md = self.dir / "IMPROVMENT.MD"
        self.penalty_py = self.dir / "PENATLITY.py"
        self._lock = threading.RLock()
        self._bootstrap()

    def _bootstrap(self) -> None:
        for path, heading in [
            (self.md, "MISTAKE LOG"),
            (self.second_md, "2ND-MISTAKE TRACKER"),
            (self.improvement_md, "IMPROVEMENT LOG"),
        ]:
            if not path.exists():
                path.write_text(
                    f"# SKT AI LABS — {heading}\n\n"
                    f"_Regenerated from `{self.jsonl.name}`. Do not edit by hand._\n\n",
                    encoding="utf-8",
                )

    # ---- IO ---------------------------------------------------------------

    def _read(self) -> List[Dict[str, Any]]:
        if not self.jsonl.exists():
            return []
        out: List[Dict[str, Any]] = []
        for line in self.jsonl.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def _append(self, record: Dict[str, Any]) -> None:
        with self._lock, _FileLock(self.jsonl):
            existing = self.jsonl.read_text(encoding="utf-8") if self.jsonl.exists() else ""
            with open(self.jsonl, "a", encoding="utf-8", newline="\n") as fp:
                if existing and not existing.endswith("\n"):
                    fp.write("\n")
                fp.write(json.dumps(record, ensure_ascii=False) + "\n")

    # ---- heuristics -------------------------------------------------------

    def _looks_repeated(self, error_class: str, error_name: str, window: int = WINDOW_SECONDS) -> bool:
        rows = self._read()
        if not rows:
            return False
        now = _dt.datetime.fromisoformat(_now())
        name = (error_name or "").strip().lower()
        for r in rows:
            try:
                ts = _dt.datetime.fromisoformat(r["timestamp"])
            except (KeyError, ValueError):
                continue
            if (now - ts).total_seconds() > window:
                continue
            if r.get("error_class") == error_class and r.get("error_name", "").lower() == name:
                return True
            # fuzzy: similar error_name (>0.8 ratio)
            ratio = difflib.SequenceMatcher(None, name, r.get("error_name", "").lower()).ratio()
            if ratio > 0.8 and r.get("error_class") == error_class:
                return True
        return False

    # ---- public API -------------------------------------------------------

    def record(
        self,
        error_name: str,
        error_description: str,
        user_input: str,
        assistant_output: str,
        who_mistake: str = "assistant",
        how_to_resolve: str = "",
        future_prevention: str = "",
        session_id: str = "",
        available_points: int = 0,
    ) -> Mistake:
        error_class = _classify(error_name + " " + error_description)
        repeated = self._looks_repeated(error_class, error_name)
        penalty = (5 if repeated else 0) * SECOND_MISTAKE_MULTIPLIER if repeated else 0
        m = Mistake(
            error_id=f"err_{uuid.uuid4().hex[:8]}",
            error_name=error_name[:200],
            error_class=error_class,
            error_description=error_description[:1000],
            error_paragraph=error_description[:4000],
            timestamp=_now(),
            user_input=user_input[:MAX_TEXT],
            assistant_output=assistant_output[:MAX_TEXT],
            tokens_consumed=_count_tokens(assistant_output),
            why_assistant_did_it="(recorded by caller)",
            reason_held="(recorded by caller)",
            who_mistake=who_mistake if who_mistake in CAUSE_OPTIONS else "assistant",
            is_device_error=error_class in {"device", "network", "oom"},
            how_to_resolve=how_to_resolve[:1000],
            is_fixed=False,
            future_prevention=future_prevention[:1000],
            repeated=repeated,
            available_points=max(0, available_points - penalty),
            session_id=session_id,
            penalty_points=penalty,
        )
        self._append(asdict(m))
        if repeated:
            self._append_second_mistake(m)
        self._regenerate_md()
        return m

    def mark_fixed(self, error_id: str, note: str = "") -> Optional[Mistake]:
        rows = self._read()
        for r in rows:
            if r.get("error_id") == error_id:
                r["is_fixed"] = True
                r["resolved_at"] = _now()
                if note:
                    r["future_prevention"] = (r.get("future_prevention", "") + "\n" + note).strip()
                # rewrite the file with the updated row
                self._rewrite(rows)
                self._regenerate_md()
                return Mistake(**r)
        return None

    def mark_will_repeat(self, error_id: str, note: str = "") -> Optional[Mistake]:
        """Flag a mistake as likely to recur with a prevention note."""
        rows = self._read()
        for r in rows:
            if r.get("error_id") == error_id:
                r["will_repeat_in_future"] = True
                if note:
                    r["future_prevention"] = (r.get("future_prevention", "") + "\n" + note).strip()
                self._rewrite(rows)
                self._regenerate_md()
                return Mistake(**r)
        return None

    def add_improvement(self, description: str, related_error: str = "") -> None:
        path = self.improvement_md
        with self._lock, _FileLock(path):
            text = path.read_text(encoding="utf-8")
            entry = f"\n## {_now()}\n- {description}\n"
            if related_error:
                entry += f"  - related error: `{related_error}`\n"
            path.write_text(text + entry, encoding="utf-8")

    def _append_second_mistake(self, m: Mistake) -> None:
        path = self.second_md
        with self._lock, _FileLock(path):
            text = path.read_text(encoding="utf-8")
            text += (
                f"\n## {m.timestamp} — {m.error_name}\n"
                f"- class: `{m.error_class}`\n"
                f"- penalty: **{m.penalty_points}** points\n"
                f"- description: {m.error_description}\n"
            )
            path.write_text(text, encoding="utf-8")

    def _rewrite(self, rows: List[Dict[str, Any]]) -> None:
        with self._lock, _FileLock(self.jsonl):
            tmp = self.jsonl.with_suffix(".jsonl.tmp")
            with open(tmp, "w", encoding="utf-8", newline="\n") as fp:
                for r in rows:
                    fp.write(json.dumps(r, ensure_ascii=False) + "\n")
            os.replace(tmp, self.jsonl)

    def _regenerate_md(self) -> None:
        rows = self._read()
        header = (
            "# SKT AI LABS — MISTAKE LOG\n\n"
            "| error_id | error_name | class | tokens | who | fixed | repeated | timestamp |\n"
            "|----------|------------|-------|--------|-----|-------|----------|-----------|\n"
        )
        body = "\n".join(
            "| " + " | ".join(
                str(r.get(c, "")) for c in
                ["error_id", "error_name", "error_class", "tokens_consumed", "who_mistake",
                 "is_fixed", "repeated", "timestamp"]
            ) + " |"
            for r in rows
        )
        self.md.write_text(header + body + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli() -> int:
    p = argparse.ArgumentParser(description="SKT mistake tracker")
    sub = p.add_subparsers(dest="cmd")

    p_rec = sub.add_parser("record", help="record a mistake")
    p_rec.add_argument("--name", required=True)
    p_rec.add_argument("--description", required=True)
    p_rec.add_argument("--user-input", default="")
    p_rec.add_argument("--assistant-output", default="")
    p_rec.add_argument("--who", default="assistant", choices=CAUSE_OPTIONS)
    p_rec.add_argument("--how", default="")
    p_rec.add_argument("--future", default="")
    p_rec.add_argument("--available", type=int, default=0)
    p_rec.add_argument("--root", default=".")

    p_fix = sub.add_parser("fix", help="mark a mistake fixed")
    p_fix.add_argument("--error-id", required=True)
    p_fix.add_argument("--note", default="")
    p_fix.add_argument("--root", default=".")

    p_repeat = sub.add_parser("will-repeat", help="flag a mistake as likely to recur")
    p_repeat.add_argument("--error-id", required=True)
    p_repeat.add_argument("--note", default="")
    p_repeat.add_argument("--root", default=".")

    p_imp = sub.add_parser("improve", help="record an improvement")
    p_imp.add_argument("--description", required=True)
    p_imp.add_argument("--related", default="")
    p_imp.add_argument("--root", default=".")

    args = p.parse_args()
    if args.cmd == "record":
        m = MistakeLedger(args.root).record(
            error_name=args.name,
            error_description=args.description,
            user_input=args.user_input,
            assistant_output=args.assistant_output,
            who_mistake=args.who,
            how_to_resolve=args.how,
            future_prevention=args.future,
            available_points=args.available,
        )
        print(json.dumps(asdict(m), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "fix":
        m = MistakeLedger(args.root).mark_fixed(args.error_id, args.note)
        print(json.dumps(asdict(m) if m else {"error": "not found"}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "will-repeat":
        m = MistakeLedger(args.root).mark_will_repeat(args.error_id, args.note)
        print(json.dumps(asdict(m) if m else {"error": "not found"}, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "improve":
        MistakeLedger(args.root).add_improvement(args.description, args.related)
        return 0
    p.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(_cli())
