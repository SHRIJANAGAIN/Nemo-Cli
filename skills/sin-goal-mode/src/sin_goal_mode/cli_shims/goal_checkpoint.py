# Purpose: CLI shim for goal_checkpoint
# Docs: goal_checkpoint.doc.md
"""CLI: goal-checkpoint — create a snapshot of current goal state.

Usage: goal-checkpoint <goal-id>
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_checkpoint, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-checkpoint")
    parser.add_argument("goal_id")
    args = parser.parse_args(argv)
    _init_state()
    print(goal_checkpoint(args.goal_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
