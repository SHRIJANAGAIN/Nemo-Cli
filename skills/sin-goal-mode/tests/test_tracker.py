"""Tests for GoalTracker (progress, status updates, subtask management).
Docs: test_tracker.doc.md
"""
import pytest
from sin_goal_mode.goals import Goal, Subtask, SubtaskStatus, GoalStatus
from sin_goal_mode.tracker import GoalTracker


class TestGoalTracker:
    """Cover tracker CRUD, status transitions, and progress helpers."""

    def test_add_and_get_goal(self):
        """Adding a goal should make it retrievable by ID."""
        t = GoalTracker()
        g = Goal(id="g1", title="Track Me")
        t.add_goal(g)
        assert t.get_goal("g1") is g

    def test_get_goal_missing(self):
        """get_goal should return None for unknown IDs."""
        t = GoalTracker()
        assert t.get_goal("missing") is None

    def test_list_active(self):
        """list_active should include PENDING and ACTIVE goals."""
        t = GoalTracker()
        t.add_goal(Goal(id="g1", title="A", status=GoalStatus.PENDING))
        t.add_goal(Goal(id="g2", title="B", status=GoalStatus.ACTIVE))
        t.add_goal(Goal(id="g3", title="C", status=GoalStatus.COMPLETED))
        active = t.list_active()
        assert len(active) == 2
        assert all(g.status in (GoalStatus.PENDING, GoalStatus.ACTIVE) for g in active)

    def test_list_completed(self):
        """list_completed should return only COMPLETED goals."""
        t = GoalTracker()
        t.add_goal(Goal(id="g1", title="A", status=GoalStatus.COMPLETED))
        t.add_goal(Goal(id="g2", title="B", status=GoalStatus.ACTIVE))
        completed = t.list_completed()
        assert len(completed) == 1
        assert completed[0].id == "g1"

    def test_list_all(self):
        """list_all should return every goal regardless of status."""
        t = GoalTracker()
        for i, s in enumerate([GoalStatus.PENDING, GoalStatus.ACTIVE, GoalStatus.COMPLETED]):
            t.add_goal(Goal(id=f"g{i}", title="T", status=s))
        assert len(t.list_all()) == 3

    def test_start_goal(self):
        """start_goal should transition PENDING → ACTIVE."""
        t = GoalTracker()
        g = Goal(id="g1", title="Start")
        t.add_goal(g)
        assert t.start_goal("g1") is True
        assert g.status == GoalStatus.ACTIVE

    def test_start_goal_not_pending(self):
        """start_goal should fail if goal is not PENDING."""
        t = GoalTracker()
        g = Goal(id="g1", title="Start", status=GoalStatus.COMPLETED)
        t.add_goal(g)
        assert t.start_goal("g1") is False

    def test_complete_goal(self):
        """complete_goal should mark ACTIVE/PENDING as COMPLETED."""
        t = GoalTracker()
        g = Goal(id="g1", title="Finish")
        t.add_goal(g)
        assert t.complete_goal("g1") is True
        assert g.status == GoalStatus.COMPLETED

    def test_complete_goal_already_completed(self):
        """complete_goal should fail if already COMPLETED."""
        t = GoalTracker()
        g = Goal(id="g1", title="Done", status=GoalStatus.COMPLETED)
        t.add_goal(g)
        assert t.complete_goal("g1") is False

    def test_fail_goal(self):
        """fail_goal should mark any goal as FAILED."""
        t = GoalTracker()
        g = Goal(id="g1", title="Fail")
        t.add_goal(g)
        assert t.fail_goal("g1") is True
        assert g.status == GoalStatus.FAILED

    def test_update_progress(self):
        """update_progress should return the goal's percentage."""
        t = GoalTracker()
        g = Goal(id="g1", title="Progress")
        g.add_subtask(Subtask(id="s1", title="A"))
        g.add_subtask(Subtask(id="s2", title="B"))
        t.add_goal(g)
        assert t.update_progress("g1") == 0.0
        t.complete_subtask("g1", "s1")
        assert t.update_progress("g1") == 50.0

    def test_update_progress_missing_goal(self):
        """update_progress for missing goal should return 0.0."""
        t = GoalTracker()
        assert t.update_progress("missing") == 0.0

    def test_add_subtask(self):
        """add_subtask should append to the goal's subtask list."""
        t = GoalTracker()
        g = Goal(id="g1", title="Sub")
        t.add_goal(g)
        st = Subtask(id="s1", title="Task")
        assert t.add_subtask("g1", st) is True
        assert len(g.subtasks) == 1

    def test_add_subtask_missing_goal(self):
        """add_subtask to missing goal should return False."""
        t = GoalTracker()
        assert t.add_subtask("missing", Subtask(id="s1", title="Task")) is False

    def test_remove_subtask(self):
        """remove_subtask should delete by ID and return True."""
        t = GoalTracker()
        g = Goal(id="g1", title="Rem")
        g.add_subtask(Subtask(id="s1", title="Task"))
        t.add_goal(g)
        assert t.remove_subtask("g1", "s1") is True
        assert len(g.subtasks) == 0

    def test_remove_subtask_missing_goal(self):
        """remove_subtask for missing goal should return False."""
        t = GoalTracker()
        assert t.remove_subtask("missing", "s1") is False

    def test_complete_subtask(self):
        """complete_subtask should mark the subtask COMPLETED."""
        t = GoalTracker()
        g = Goal(id="g1", title="Comp")
        g.add_subtask(Subtask(id="s1", title="Task"))
        t.add_goal(g)
        assert t.complete_subtask("g1", "s1") is True
        assert g.subtasks[0].status == SubtaskStatus.COMPLETED

    def test_complete_subtask_missing_goal(self):
        """complete_subtask for missing goal should return False."""
        t = GoalTracker()
        assert t.complete_subtask("missing", "s1") is False

    def test_block_subtask(self):
        """block_subtask should mark subtask BLOCKED with reason."""
        t = GoalTracker()
        g = Goal(id="g1", title="Block")
        g.add_subtask(Subtask(id="s1", title="Task"))
        t.add_goal(g)
        assert t.block_subtask("g1", "s1", "reason") is True
        assert g.subtasks[0].status == SubtaskStatus.BLOCKED

    def test_block_subtask_missing_goal(self):
        """block_subtask for missing goal should return False."""
        t = GoalTracker()
        assert t.block_subtask("missing", "s1") is False

    def test_get_status(self):
        """get_status should return a human-readable summary string."""
        t = GoalTracker()
        g = Goal(id="g1", title="Status")
        g.add_subtask(Subtask(id="s1", title="A"))
        g.add_subtask(Subtask(id="s2", title="B"))
        t.add_goal(g)
        t.start_goal("g1")
        t.complete_subtask("g1", "s1")
        t.block_subtask("g1", "s2", "err")
        status = t.get_status("g1")
        assert "active" in status.lower()
        assert "1/2" in status
        assert "1 in progress" in status or "0 in progress" in status
        assert "1 blocked" in status

    def test_get_status_missing_goal(self):
        """get_status for missing goal should return None."""
        t = GoalTracker()
        assert t.get_status("missing") is None

    def test_get_blockers(self):
        """get_blockers should return titles of BLOCKED subtasks."""
        t = GoalTracker()
        g = Goal(id="g1", title="Blockers")
        g.add_subtask(Subtask(id="s1", title="B1"))
        g.add_subtask(Subtask(id="s2", title="B2"))
        t.add_goal(g)
        t.block_subtask("g1", "s1", "r1")
        t.block_subtask("g1", "s2", "r2")
        assert t.get_blockers("g1") == ["B1", "B2"]

    def test_get_blockers_missing_goal(self):
        """get_blockers for missing goal should return empty list."""
        t = GoalTracker()
        assert t.get_blockers("missing") == []
