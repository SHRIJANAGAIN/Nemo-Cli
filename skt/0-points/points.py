
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

POINT_VALUES: Dict[str, int] = {
    "easy": 1,
    "normal": 3,
    "medium": 5,
    "high": 10,
    "critical": 20,
}

BONUS_FIRST_TRY = 2
BONUS_NO_ERRORS = 1
BONUS_USER_POSITIVE = 3

PENALTY_REPEATED = 5
PENALTY_HALLUCINATION = 10
PENALTY_USER_CORRECTION = 3

TASK_TYPES = list(POINT_VALUES.keys())

VALID_TASK_NAME = re.compile(r"^[a-zA-Z0-9 _.\-]{1,80}$")
MAX_OUTPUT_LEN = 8000
MAX_FEEDBACK_LEN = 1000


@dataclass
class PointEntry:
    """A single award or deduction event."""

    task_id: str
    task_name: str
    task_description: str
    task_type: str
    points_given: int
    timestamp: str
    user_feedback: str
    assistant_output: str
    available_points: int
    session_id: str = ""
    bonus_first_try: bool = False
    bonus_no_errors: bool = False
    bonus_user_positive: bool = False
    penalty_repeated: bool = False
    penalty_hallucination: bool = False
    penalty_user_correction: bool = False
    reason: str = ""

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @staticmethod
    def from_jsonl(line: str) -> "PointEntry":
        data = json.loads(line)
        return PointEntry(**data)


@dataclass
class ExcludedPointEntry:
    """A penalty / deduction entry — kept separate from the main ledger."""

    task_id: str
    task_name: str
    task_description: str
    task_type: str
    points_reduced: int
    timestamp: str
    user_feedback: str
    user_input: str
    assistant_output: str
    available_points: int
    reason: str = ""
    repeated: bool = False

    def to_jsonl(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False)

    @staticmethod
    def from_jsonl(line: str) -> "ExcludedPointEntry":
        data = json.loads(line)
        return ExcludedPointEntry(**data)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


class _AtomicWrite:
    """Write to a temp file then rename — avoids torn writes."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def __enter__(self) -> Path:
        self.tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        self.fp = open(self.tmp, "w", encoding="utf-8", newline="\n")
        return self.tmp

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if self.fp and not self.fp.closed:
                self.fp.flush()
                os.fsync(self.fp.fileno())
                self.fp.close()
            if exc_type is None:
                os.replace(self.tmp, self.path)
            else:
                try:
                    self.tmp.unlink()
                except FileNotFoundError:
                    pass
        except Exception:
            try:
                self.tmp.unlink()
            except FileNotFoundError:
                pass
            raise


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------


class PointsLedger:
    """Persistent points + exclusion ledger with thread-safe append."""

    def __init__(self, root: str | os.PathLike[str] = ".") -> None:
        self.root = Path(root)
        self.points_dir = self.root / "skt" / "0-points"
        self.points_dir.mkdir(parents=True, exist_ok=True)
        self.points_md = self.points_dir / "points.md"
        self.excluded_md = self.points_dir / "excludedpoints.md"
        self.points_jsonl = self.points_dir / "points.jsonl"
        self.excluded_jsonl = self.points_dir / "excludedpoints.jsonl"
        self._lock = threading.RLock()
        self._bootstrap_files()

    # ---- file bootstrap ---------------------------------------------------

    def _bootstrap_files(self) -> None:
        if not self.points_md.exists():
            self._write_schema_md(self.points_md, heading="Points Ledger")
        if not self.excluded_md.exists():
            self._write_schema_md(self.excluded_md, heading="Excluded Points Ledger")

    @staticmethod
    def _write_schema_md(path: Path, heading: str) -> None:
        text = (
            f"# SKT AI LABS — {heading}\n\n"
            "Every row is an immutable award or deduction event. The canonical "
            "machine-readable form lives in the sibling `.jsonl` file. This "
            "Markdown mirror is regenerated for human review.\n\n"
            "| task_id | task_name | task_type | points | timestamp | available | reason |\n"
            "|---------|-----------|-----------|--------|-----------|-----------|--------|\n"
        )
        path.write_text(text, encoding="utf-8")

    # ---- helpers ----------------------------------------------------------

    def _read_jsonl(self, path: Path) -> List[Dict[str, Any]]:
        if not path.exists():
            return []
        out: List[Dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    def _append_jsonl(self, path: Path, record: Dict[str, Any]) -> None:
        with self._lock:
            existing = path.read_text(encoding="utf-8") if path.exists() else ""
            with open(path, "a", encoding="utf-8", newline="\n") as fp:
                if existing and not existing.endswith("\n"):
                    fp.write("\n")
                fp.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _regenerate_md(self, md_path: Path, rows: Iterable[Dict[str, Any]], columns: List[str]) -> None:
        header = (
            f"# SKT AI LABS — {md_path.stem}\n\n"
            "| " + " | ".join(columns) + " |\n"
            "|" + "|".join(["---"] * len(columns)) + "|\n"
        )
        body = "\n".join("| " + " | ".join(str(r.get(c, "")) for c in columns) + " |" for r in rows)
        md_path.write_text(header + body + "\n", encoding="utf-8")

    # ---- queries ----------------------------------------------------------

    def available(self) -> int:
        rows = self._read_jsonl(self.points_jsonl)
        return int(rows[-1]["available_points"]) if rows else 0

    def history(self, limit: int = 50) -> List[Dict[str, Any]]:
        rows = self._read_jsonl(self.points_jsonl)
        return list(reversed(rows[-limit:]))

    def excluded_total(self) -> int:
        rows = self._read_jsonl(self.excluded_jsonl)
        return sum(int(r.get("points_reduced", 0)) for r in rows)

    # ---- mutations --------------------------------------------------------

    def award(
        self,
        task_id: str,
        task_name: str,
        task_type: str,
        user_feedback: str = "",
        assistant_output: str = "",
        task_description: str = "",
        session_id: str = "",
        bonus_first_try: bool = False,
        bonus_no_errors: bool = False,
        bonus_user_positive: bool = False,
        reason: str = "",
    ) -> PointEntry:
        """Record a points award. Returns the persisted entry."""
        if task_type not in POINT_VALUES:
            raise ValueError(f"invalid task_type {task_type!r}; expected one of {TASK_TYPES}")
        if not VALID_TASK_NAME.match(task_name):
            raise ValueError(f"invalid task_name {task_name!r}")
        points = POINT_VALUES[task_type]
        if bonus_first_try:
            points += BONUS_FIRST_TRY
        if bonus_no_errors:
            points += BONUS_NO_ERRORS
        if bonus_user_positive:
            points += BONUS_USER_POSITIVE
        prev = self.available()
        entry = PointEntry(
            task_id=task_id or f"t_{uuid.uuid4().hex[:8]}",
            task_name=task_name,
            task_description=task_description,
            task_type=task_type,
            points_given=points,
            timestamp=_now_iso(),
            user_feedback=user_feedback[:MAX_FEEDBACK_LEN],
            assistant_output=assistant_output[:MAX_OUTPUT_LEN],
            available_points=prev + points,
            session_id=session_id,
            bonus_first_try=bonus_first_try,
            bonus_no_errors=bonus_no_errors,
            bonus_user_positive=bonus_user_positive,
            reason=reason,
        )
        with self._lock:
            self._append_jsonl(self.points_jsonl, asdict(entry))
            self._regenerate_md(
                self.points_md,
                self._read_jsonl(self.points_jsonl),
                ["task_id", "task_name", "task_type", "points_given", "timestamp", "available_points", "reason"],
            )
        return entry

    def deduct(
        self,
        task_id: str,
        task_name: str,
        task_type: str,
        user_input: str = "",
        user_feedback: str = "",
        assistant_output: str = "",
        points_reduced: int = PENALTY_REPEATED,
        task_description: str = "",
        reason: str = "",
        repeated: bool = False,
    ) -> ExcludedPointEntry:
        """Record a penalty. Negative points reduce the available balance."""
        if task_type not in POINT_VALUES:
            raise ValueError(f"invalid task_type {task_type!r}")
        if points_reduced <= 0:
            raise ValueError("points_reduced must be positive")
        prev = self.available()
        new_balance = prev - points_reduced
        entry = ExcludedPointEntry(
            task_id=task_id or f"x_{uuid.uuid4().hex[:8]}",
            task_name=task_name,
            task_description=task_description,
            task_type=task_type,
            points_reduced=points_reduced,
            timestamp=_now_iso(),
            user_feedback=user_feedback[:MAX_FEEDBACK_LEN],
            user_input=user_input[:MAX_OUTPUT_LEN],
            assistant_output=assistant_output[:MAX_OUTPUT_LEN],
            available_points=new_balance,
            reason=reason,
            repeated=repeated,
        )
        with self._lock:
            self._append_jsonl(self.excluded_jsonl, asdict(entry))
            # Mirror the new balance in the main ledger as a zero-points row.
            mirror = PointEntry(
                task_id=f"mirror_{entry.task_id}",
                task_name=f"[DEDUCT] {task_name}",
                task_description=task_description,
                task_type=task_type,
                points_given=-points_reduced,
                timestamp=entry.timestamp,
                user_feedback=user_feedback,
                assistant_output=assistant_output[:2000],
                available_points=new_balance,
                session_id="",
                reason=reason or "deduction",
            )
            self._append_jsonl(self.points_jsonl, asdict(mirror))
            self._regenerate_md(
                self.excluded_md,
                self._read_jsonl(self.excluded_jsonl),
                ["task_id", "task_name", "task_type", "points_reduced", "timestamp", "available_points", "reason"],
            )
            self._regenerate_md(
                self.points_md,
                self._read_jsonl(self.points_jsonl),
                ["task_id", "task_name", "task_type", "points_given", "timestamp", "available_points", "reason"],
            )
        return entry

    # ---- analytics --------------------------------------------------------

    def summary(self) -> Dict[str, Any]:
        awards = self._read_jsonl(self.points_jsonl)
        excluded = self._read_jsonl(self.excluded_jsonl)
        by_type: Dict[str, int] = {}
        for r in awards:
            t = r.get("task_type", "unknown")
            by_type[t] = by_type.get(t, 0) + int(r.get("points_given", 0))
        return {
            "available": self.available(),
            "excluded_total": self.excluded_total(),
            "awards_total": sum(int(r.get("points_given", 0)) for r in awards),
            "events": len(awards),
            "by_type": by_type,
            "last_event_ts": awards[-1]["timestamp"] if awards else None,
        }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _cli() -> int:
    parser = argparse.ArgumentParser(description="SKT points ledger")
    sub = parser.add_subparsers(dest="cmd")

    p_award = sub.add_parser("award", help="record a points award")
    p_award.add_argument("--task-id", default="")
    p_award.add_argument("--task-name", required=True)
    p_award.add_argument("--task-type", required=True, choices=TASK_TYPES)
    p_award.add_argument("--description", default="")
    p_award.add_argument("--feedback", default="")
    p_award.add_argument("--output", default="")
    p_award.add_argument("--first-try", action="store_true")
    p_award.add_argument("--no-errors", action="store_true")
    p_award.add_argument("--user-positive", action="store_true")
    p_award.add_argument("--reason", default="")
    p_award.add_argument("--root", default=".")

    p_deduct = sub.add_parser("deduct", help="record a penalty")
    p_deduct.add_argument("--task-id", default="")
    p_deduct.add_argument("--task-name", required=True)
    p_deduct.add_argument("--task-type", required=True, choices=TASK_TYPES)
    p_deduct.add_argument("--description", default="")
    p_deduct.add_argument("--feedback", default="")
    p_deduct.add_argument("--input", default="")
    p_deduct.add_argument("--output", default="")
    p_deduct.add_argument("--points", type=int, default=PENALTY_REPEATED)
    p_deduct.add_argument("--repeated", action="store_true")
    p_deduct.add_argument("--reason", default="")
    p_deduct.add_argument("--root", default=".")

    p_show = sub.add_parser("show", help="show ledger summary")
    p_show.add_argument("--root", default=".")

    args = parser.parse_args()
    if args.cmd == "award":
        ledger = PointsLedger(args.root)
        entry = ledger.award(
            task_id=args.task_id,
            task_name=args.task_name,
            task_type=args.task_type,
            task_description=args.description,
            user_feedback=args.feedback,
            assistant_output=args.output,
            bonus_first_try=args.first_try,
            bonus_no_errors=args.no_errors,
            bonus_user_positive=args.user_positive,
            reason=args.reason,
        )
        print(json.dumps(asdict(entry), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "deduct":
        ledger = PointsLedger(args.root)
        entry = ledger.deduct(
            task_id=args.task_id,
            task_name=args.task_name,
            task_type=args.task_type,
            user_input=args.input,
            user_feedback=args.feedback,
            assistant_output=args.output,
            points_reduced=args.points,
            task_description=args.description,
            reason=args.reason,
            repeated=args.repeated,
        )
        print(json.dumps(asdict(entry), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "show":
        ledger = PointsLedger(args.root)
        print(json.dumps(ledger.summary(), ensure_ascii=False, indent=2))
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(_cli())
