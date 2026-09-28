"""Tests for Goal lifecycle (start, active, complete, fail, rollback).
Docs: test_goals.doc.md
"""
import uuid
import pytest
from sin_goal_mode.goals import Goal, GoalStatus, Subtask, SubtaskStatus


class TestGoalLifecycle:
    """Cover goal state transitions and basic properties."""

    def test_goal_create_default_status(self):
        """A newly created goal should have PENDING status."""
        g = Goal(id="g1", title="Test Goal")
        assert g.status == GoalStatus.PENDING

    def test_goal_mark_active(self):
        """mark_active should transition PENDING → ACTIVE."""
        g = Goal(id="g2", title="Active Goal")
        g.mark_active()
        assert g.status == GoalStatus.ACTIVE

    def test_goal_mark_completed(self):
        """mark_completed should transition to COMPLETED and set timestamp."""
        g = Goal(id="g3", title="Complete Goal")
        g.mark_completed()
        assert g.status == GoalStatus.COMPLETED
        assert g.completed_at is not None

    def test_goal_mark_failed(self):
        """mark_failed should transition to FAILED."""
        g = Goal(id="g4", title="Failed Goal")
        g.mark_failed()
        assert g.status == GoalStatus.FAILED

    def test_goal_mark_rolled_back(self):
        """mark_rolled_back should transition to ROLLED_BACK."""
        g = Goal(id="g5", title="Rollback Goal")
        g.mark_rolled_back()
        assert g.status == GoalStatus.ROLLED_BACK

    def test_goal_progress_no_subtasks_not_completed(self):
        """Goal with no subtasks and not completed should have 0% progress."""
        g = Goal(id="g6", title="No Subtasks")
        assert g.progress_pct() == 0.0

    def test_goal_progress_no_subtasks_completed(self):
        """Goal with no subtasks but marked completed should have 100% progress."""
        g = Goal(id="g7", title="Completed No Subtasks")
        g.mark_completed()
        assert g.progress_pct() == 100.0

    def test_goal_progress_with_subtasks(self):
        """Progress should reflect fraction of completed subtasks."""
        g = Goal(id="g8", title="Partial Progress")
        g.add_subtask(Subtask(id="s1", title="A"))
        g.add_subtask(Subtask(id="s2", title="B"))
        assert g.progress_pct() == 0.0
        g.subtasks[0].mark_completed()
        assert g.progress_pct() == 50.0
        g.subtasks[1].mark_completed()
        assert g.progress_pct() == 100.0

    def test_goal_add_subtask(self):
        """add_subtask should append and update timestamp."""
        g = Goal(id="g9", title="Add Subtask")
        before = g.updated_at
        st = Subtask(id="s1", title="Sub")
        g.add_subtask(st)
        assert len(g.subtasks) == 1
        assert g.updated_at > before

    def test_goal_remove_subtask_found(self):
        """remove_subtask should return True when ID exists."""
        g = Goal(id="g10", title="Remove Subtask")
        g.add_subtask(Subtask(id="s1", title="Sub"))
        assert g.remove_subtask("s1") is True
        assert len(g.subtasks) == 0

    def test_goal_remove_subtask_not_found(self):
        """remove_subtask should return False when ID does not exist."""
        g = Goal(id="g11", title="Remove Missing")
        assert g.remove_subtask("missing") is False

    def test_goal_add_checkpoint(self):
        """add_checkpoint should record the checkpoint ID."""
        g = Goal(id="g12", title="Checkpoint")
        g.add_checkpoint("cp1")
        assert "cp1" in g.checkpoints

    def test_goal_to_dict_roundtrip(self):
        """to_dict → from_dict should reconstruct an identical goal."""
        g = Goal(id="g13", title="Roundtrip", description="desc", status=GoalStatus.ACTIVE)
        g.add_subtask(Subtask(id="s1", title="Sub", status=SubtaskStatus.IN_PROGRESS))
        g.add_checkpoint("cp1")
        data = g.to_dict()
        g2 = Goal.from_dict(data)
        assert g2.id == g.id
        assert g2.title == g.title
        assert g2.status == g.status
        assert len(g2.subtasks) == len(g.subtasks)
        assert g2.checkpoints == g.checkpoints

    def test_goal_metadata_defaults(self):
        """metadata should default to an empty dict."""
        g = Goal(id="g14", title="Meta")
        assert g.metadata == {}

    def test_goal_description_defaults(self):
        """description should default to empty string."""
        g = Goal(id="g15", title="Desc")
        assert g.description == ""

    def test_goal_created_at_set(self):
        """created_at should be set automatically at construction."""
        g = Goal(id="g16", title="Created")
        assert g.created_at is not None

    def test_goal_subtask_mark_in_progress(self):
        """Subtask.mark_in_progress should update status and timestamp."""
        st = Subtask(id="s1", title="Progress")
        st.mark_in_progress()
        assert st.status == SubtaskStatus.IN_PROGRESS
        assert st.updated_at is not None

    def test_goal_subtask_mark_blocked(self):
        """Subtask.mark_blocked should update status and append reason."""
        st = Subtask(id="s1", title="Block")
        st.mark_blocked("network issue")
        assert st.status == SubtaskStatus.BLOCKED
        assert "network issue" in st.description

    def test_goal_subtask_to_dict_roundtrip(self):
        """Subtask to_dict → from_dict should reconstruct."""
        st = Subtask(id="s1", title="Round", description="d", status=SubtaskStatus.COMPLETED)
        st.mark_completed()
        data = st.to_dict()
        st2 = Subtask.from_dict(data)
        assert st2.id == st.id
        assert st2.title == st.title
        assert st2.status == st.status
        assert st2.completed_at == st.completed_at
