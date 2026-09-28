# Purpose: CLI shim for goal_subtask
# Docs: goal_subtask.doc.md
"""CLI: goal-subtask — add/update/remove a subtask.

Usage: goal-subtask <goal-id> <action> [--subtask-id ID] [--title T] [--description D]
       action: add | remove | complete | block
"""
from __future__ import annotations
import argparse
import sys
from ..server import goal_subtask, _init_state


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="goal-subtask")
    parser.add_argument("goal_id")
    parser.add_argument("action", choices=["add", "remove", "complete", "block"])
    parser.add_argument("--subtask-id", default="")
    parser.add_argument("--title", default="")
    parser.add_argument("--description", default="")
    args = parser.parse_args(argv)
    _init_state()
    print(goal_subtask(
        goal_id=args.goal_id,
        action=args.action,
        subtask_id=args.subtask_id,
        title=args.title,
        description=args.description,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
