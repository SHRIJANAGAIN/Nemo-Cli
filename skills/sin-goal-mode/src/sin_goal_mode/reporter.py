# Purpose: Generate progress reports for goals in Markdown format.
# Docs: reporter.doc.md

from datetime import datetime
from typing import List, Optional
from .goals import Goal, GoalStatus, SubtaskStatus


class Reporter:
    """Generates human-readable progress reports for goals."""

    def __init__(self, goals: List[Goal] = None):
        """Initialize reporter with an optional list of goals."""
        self._goals = goals if goals is not None else []

    def set_goals(self, goals: List[Goal]) -> None:
        """Update the internal list of goals."""
        self._goals = goals

    def generate_report(self, goal_id: Optional[str] = None) -> str:
        """Generate a Markdown report for all goals or a single goal."""
        if goal_id:
            goal = next((g for g in self._goals if g.id == goal_id), None)
            if goal:
                return self._goal_report(goal)
            return f"Goal `{goal_id}` not found."
        return self._full_report()

    def _full_report(self) -> str:
        """Generate a comprehensive report of all goals."""
        lines = ["# Goal Progress Report", ""]
        total = len(self._goals)
        active = [g for g in self._goals if g.status == GoalStatus.ACTIVE]
        completed = [g for g in self._goals if g.status == GoalStatus.COMPLETED]
        pending = [g for g in self._goals if g.status == GoalStatus.PENDING]
        failed = [g for g in self._goals if g.status == GoalStatus.FAILED]

        lines.append(f"Generated: {datetime.now().isoformat()}")
        lines.append(f"\n## Summary\n")
        lines.append(f"- Total goals: {total}")
        lines.append(f"- Active: {len(active)}")
        lines.append(f"- Completed: {len(completed)}")
        lines.append(f"- Pending: {len(pending)}")
        lines.append(f"- Failed: {len(failed)}")
        lines.append("")

        if active:
            lines.append("## Active Goals\n")
            for g in active:
                lines.append(f"### {g.title} (`{g.id}`)")
                lines.append(f"- Progress: {g.progress_pct():.1f}%")
                lines.append(f"- Updated: {g.updated_at}")
                lines.append(f"- Subtasks: {len(g.subtasks)}")
                lines.append("")

        if completed:
            lines.append("## Completed Goals\n")
            for g in completed:
                lines.append(f"- {g.title} (`{g.id}`) — completed at {g.completed_at}")
            lines.append("")

        if pending:
            lines.append("## Pending Goals\n")
            for g in pending:
                lines.append(f"- {g.title} (`{g.id}`)")
            lines.append("")

        if failed:
            lines.append("## Failed Goals\n")
            for g in failed:
                lines.append(f"- {g.title} (`{g.id}`) — failed at {g.updated_at}")
            lines.append("")

        return "\n".join(lines)

    def _goal_report(self, goal: Goal) -> str:
        """Generate a detailed report for a single goal."""
        lines = [f"# Goal: {goal.title}", ""]
        lines.append(f"**ID:** `{goal.id}`")
        lines.append(f"**Status:** {goal.status.value}")
        lines.append(f"**Progress:** {goal.progress_pct():.1f}%")
        lines.append(f"**Created:** {goal.created_at}")
        lines.append(f"**Updated:** {goal.updated_at}")
        if goal.completed_at:
            lines.append(f"**Completed:** {goal.completed_at}")
        lines.append("")

        if goal.description:
            lines.append(f"## Description\n\n{goal.description}\n")

        lines.append(f"## Subtasks ({len(goal.subtasks)})\n")
        for st in goal.subtasks:
            icon = {
                SubtaskStatus.COMPLETED: "[x]",
                SubtaskStatus.IN_PROGRESS: "[~]",
                SubtaskStatus.BLOCKED: "[!]",
                SubtaskStatus.PENDING: "[ ]",
            }.get(st.status, "[ ]")
            lines.append(f"- {icon} {st.title} (`{st.id}`) — {st.status.value}")
        lines.append("")

        blockers = [st for st in goal.subtasks if st.status == SubtaskStatus.BLOCKED]
        if blockers:
            lines.append("## Blockers\n")
            for st in blockers:
                lines.append(f"- {st.title}: {st.description}")
            lines.append("")

        if goal.checkpoints:
            lines.append(f"## Checkpoints\n")
            for cp in goal.checkpoints:
                lines.append(f"- `{cp}`")
            lines.append("")

        return "\n".join(lines)

    def generate_summary(self) -> str:
        """Generate a one-line summary of all goals."""
        total = len(self._goals)
        completed = len([g for g in self._goals if g.status == GoalStatus.COMPLETED])
        active = len([g for g in self._goals if g.status == GoalStatus.ACTIVE])
        return f"{completed}/{total} completed, {active} active"
