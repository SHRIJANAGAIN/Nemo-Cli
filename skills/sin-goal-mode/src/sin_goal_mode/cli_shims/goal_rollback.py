# Purpose: CLI shim for goal_rollback
# Docs: goal_rollback.doc.md
"""CLI: goal-rollback — rollback a goal to a checkpoint.

Usage: goal-rollback <goal-id> [--checkpoint-id ID]
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_rollback, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-rollback")
    parser.add_argument("goal_id")
    parser.add_argument("--checkpoint-id", default="")
    args = parser.parse_args(argv)
    _init_state()
    print(goal_rollback(args.goal_id, checkpoint_id=args.checkpoint_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
