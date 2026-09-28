# Purpose: CLI shim for goal_report
# Docs: goal_report.doc.md
"""CLI: goal-report — generate a progress report.

Usage: goal-report [--goal-id ID] [--format markdown|json]
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_report, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-report")
    parser.add_argument("--goal-id", default="")
    parser.add_argument("--format", default="markdown", choices=["markdown", "json"])
    args = parser.parse_args(argv)
    _init_state()
    print(goal_report(goal_id=args.goal_id, format=args.format))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
