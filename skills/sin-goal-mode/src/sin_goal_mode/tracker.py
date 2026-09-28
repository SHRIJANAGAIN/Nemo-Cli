# Purpose: Track goal progress and manage status transitions.
# Docs: tracker.doc.md

from typing import List, Optional
from .goals import Goal, GoalStatus, SubtaskStatus, Subtask


class GoalTracker:
    """Tracks progress and status updates for goals."""

    def __init__(self, goals: List[Goal] = None):
        """Initialize tracker with an optional list of goals."""
        self._goals: List[Goal] = goals if goals is not None else []

    def add_goal(self, goal: Goal) -> None:
        """Add a new goal to the tracker."""
        self._goals.append(goal)

    def get_goal(self, goal_id: str) -> Optional[Goal]:
        """Retrieve a goal by its ID."""
        for g in self._goals:
            if g.id == goal_id:
                return g
        return None

    def list_active(self) -> List[Goal]:
        """Return all goals with status ACTIVE or PENDING."""
        return [g for g in self._goals if g.status in (GoalStatus.ACTIVE, GoalStatus.PENDING)]

    def list_completed(self) -> List[Goal]:
        """Return all completed goals."""
        return [g for g in self._goals if g.status == GoalStatus.COMPLETED]

    def list_all(self) -> List[Goal]:
        """Return all goals regardless of status."""
        return list(self._goals)

    def start_goal(self, goal_id: str) -> bool:
        """Transition a goal from PENDING to ACTIVE."""
        goal = self.get_goal(goal_id)
        if goal and goal.status == GoalStatus.PENDING:
            goal.mark_active()
            return True
        return False

    def complete_goal(self, goal_id: str) -> bool:
        """Transition a goal to COMPLETED if ACTIVE or PENDING."""
        goal = self.get_goal(goal_id)
        if goal and goal.status in (GoalStatus.ACTIVE, GoalStatus.PENDING):
            goal.mark_completed()
            return True
        return False

    def fail_goal(self, goal_id: str) -> bool:
        """Transition a goal to FAILED."""
        goal = self.get_goal(goal_id)
        if goal:
            goal.mark_failed()
            return True
        return False

    def update_progress(self, goal_id: str) -> float:
        """Recalculate and return the goal's progress percentage."""
        goal = self.get_goal(goal_id)
        if not goal:
            return 0.0
        return goal.progress_pct()

    def add_subtask(self, goal_id: str, subtask: Subtask) -> bool:
        """Add a subtask to a goal."""
        goal = self.get_goal(goal_id)
        if goal:
            goal.add_subtask(subtask)
            return True
        return False

    def remove_subtask(self, goal_id: str, subtask_id: str) -> bool:
        """Remove a subtask from a goal by its ID."""
        goal = self.get_goal(goal_id)
        if goal:
            return goal.remove_subtask(subtask_id)
        return False

    def complete_subtask(self, goal_id: str, subtask_id: str) -> bool:
        """Mark a subtask as completed."""
        goal = self.get_goal(goal_id)
        if not goal:
            return False
        for st in goal.subtasks:
            if st.id == subtask_id:
                st.mark_completed()
                goal.updated_at = st.updated_at
                return True
        return False

    def block_subtask(self, goal_id: str, subtask_id: str, reason: str = "") -> bool:
        """Mark a subtask as blocked with an optional reason."""
        goal = self.get_goal(goal_id)
        if not goal:
            return False
        for st in goal.subtasks:
            if st.id == subtask_id:
                st.mark_blocked(reason)
                goal.updated_at = st.updated_at
                return True
        return False

    def get_status(self, goal_id: str) -> Optional[str]:
        """Return a human-readable status summary for a goal."""
        goal = self.get_goal(goal_id)
        if not goal:
            return None
        total = len(goal.subtasks)
        completed = sum(1 for st in goal.subtasks if st.status == SubtaskStatus.COMPLETED)
        in_progress = sum(1 for st in goal.subtasks if st.status == SubtaskStatus.IN_PROGRESS)
        blocked = sum(1 for st in goal.subtasks if st.status == SubtaskStatus.BLOCKED)
        return f"{goal.status.value} — {completed}/{total} subtasks completed, {in_progress} in progress, {blocked} blocked"

    def get_blockers(self, goal_id: str) -> List[str]:
        """Return titles of blocked subtasks for a goal."""
        goal = self.get_goal(goal_id)
        if not goal:
            return []
        return [st.title for st in goal.subtasks if st.status == SubtaskStatus.BLOCKED]
