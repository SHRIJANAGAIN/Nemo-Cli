# Purpose: CLI shim for goal_complete
# Docs: goal_complete.doc.md
"""CLI: goal-complete — mark a goal as complete.

Usage: goal-complete <goal-id>
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_complete, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-complete")
    parser.add_argument("goal_id")
    args = parser.parse_args(argv)
    _init_state()
    print(goal_complete(args.goal_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
