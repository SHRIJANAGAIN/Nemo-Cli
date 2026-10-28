# Purpose: CLI shim for goal_status
# Docs: goal_status.doc.md
"""CLI: goal-status — show current goal status.

Usage: goal-status <goal-id>
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_status, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-status")
    parser.add_argument("goal_id")
    args = parser.parse_args(argv)
    _init_state()
    print(goal_status(args.goal_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
