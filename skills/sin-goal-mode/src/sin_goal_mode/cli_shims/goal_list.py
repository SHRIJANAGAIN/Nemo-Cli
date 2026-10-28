# Purpose: CLI shim for goal_list
# Docs: goal_list.doc.md
"""CLI: goal-list — list all goals, optionally filtered.

Usage: goal-list [--filter-status active|completed|pending|failed]
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_list, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-list")
    parser.add_argument(
        "--filter-status",
        choices=["active", "completed", "pending", "failed"],
        default="",
    )
    args = parser.parse_args(argv)
    _init_state()
    print(goal_list(filter_status=args.filter_status))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
