# Purpose: CLI shim for goal_start
# Docs: goal_start.doc.md
"""CLI: goal-start — start a new goal.

Usage: goal-start <title> [--description DESC] [--subtasks JSON]
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_start, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-start")
    parser.add_argument("title")
    parser.add_argument("--description", default="")
    parser.add_argument("--subtasks", default="", help="JSON list of subtask titles")
    args = parser.parse_args(argv)
    _init_state()
    print(goal_start(args.title, description=args.description, subtasks=args.subtasks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
