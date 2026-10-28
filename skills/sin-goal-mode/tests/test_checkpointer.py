"""Tests for Checkpointer (snapshot, rollback, listing).
Docs: test_checkpointer.doc.md
"""
import uuid
import pytest
from sin_goal_mode.goals import Goal, Subtask, GoalStatus
from sin_goal_mode.checkpointer import Checkpoint, Checkpointer


class TestCheckpoint:
    """Cover checkpoint creation and serialization."""

    def test_checkpoint_create(self):
        """Checkpoint should store goal snapshot and timestamp."""
        g = Goal(id="g1", title="Snap")
        cp = Checkpoint("cp1", "g1", g.to_dict())
        assert cp.checkpoint_id == "cp1"
        assert cp.goal_id == "g1"
        assert cp.snapshot["id"] == "g1"
        assert cp.created_at is not None

    def test_checkpoint_to_dict_roundtrip(self):
        """to_dict → from_dict should reconstruct identically."""
        g = Goal(id="g1", title="Round")
        cp = Checkpoint("cp1", "g1", g.to_dict())
        data = cp.to_dict()
        cp2 = Checkpoint.from_dict(data)
        assert cp2.checkpoint_id == cp.checkpoint_id
        assert cp2.goal_id == cp.goal_id
        assert cp2.snapshot == cp.snapshot


class TestCheckpointer:
    """Cover checkpointer create, get, list, rollback, delete."""

    def test_create_checkpoint(self):
        """create_checkpoint should return a UUID and store snapshot."""
        c = Checkpointer()
        g = Goal(id="g1", title="Check")
        cp_id = c.create_checkpoint(g)
        assert cp_id is not None
        assert len(c.list_checkpoints("g1")) == 1

    def test_get_checkpoint(self):
        """get_checkpoint should return the stored checkpoint."""
        c = Checkpointer()
        g = Goal(id="g1", title="Get")
        cp_id = c.create_checkpoint(g)
        cp = c.get_checkpoint(cp_id)
        assert cp is not None
        assert cp.goal_id == "g1"

    def test_get_checkpoint_missing(self):
        """get_checkpoint should return None for unknown ID."""
        c = Checkpointer()
        assert c.get_checkpoint("missing") is None

    def test_list_checkpoints(self):
        """list_checkpoints should return only checkpoints for that goal."""
        c = Checkpointer()
        g1 = Goal(id="g1", title="One")
        g2 = Goal(id="g2", title="Two")
        c.create_checkpoint(g1)
        c.create_checkpoint(g1)
        c.create_checkpoint(g2)
        assert len(c.list_checkpoints("g1")) == 2
        assert len(c.list_checkpoints("g2")) == 1

    def test_latest_checkpoint(self):
        """get_latest_checkpoint should return the most recent."""
        c = Checkpointer()
        g = Goal(id="g1", title="Latest")
        c.create_checkpoint(g)
        cp2 = c.create_checkpoint(g)
        latest = c.get_latest_checkpoint("g1")
        assert latest.checkpoint_id == cp2

    def test_latest_checkpoint_none(self):
        """get_latest_checkpoint should return None when no checkpoints exist."""
        c = Checkpointer()
        assert c.get_latest_checkpoint("g1") is None

    def test_rollback(self):
        """rollback should restore the goal snapshot and set status ROLLED_BACK."""
        c = Checkpointer()
        g = Goal(id="g1", title="Roll", description="original")
        g.add_subtask(Subtask(id="s1", title="Sub"))
        cp_id = c.create_checkpoint(g)
        # Mutate goal
        g.title = "Mutated"
        g.remove_subtask("s1")
        restored = c.rollback("g1", cp_id)
        assert restored is not None
        assert restored.title == "Roll"
        assert restored.status.value == "rolled_back"
        assert len(restored.subtasks) == 1

    def test_rollback_latest(self):
        """rollback without explicit checkpoint_id should use the latest."""
        c = Checkpointer()
        g = Goal(id="g1", title="Latest Roll")
        c.create_checkpoint(g)
        g.title = "Mutated"
        restored = c.rollback("g1")
        assert restored is not None
        assert restored.title == "Latest Roll"

    def test_rollback_wrong_goal(self):
        """rollback should return None if checkpoint belongs to a different goal."""
        c = Checkpointer()
        g1 = Goal(id="g1", title="One")
        cp_id = c.create_checkpoint(g1)
        assert c.rollback("g2", cp_id) is None

    def test_rollback_no_checkpoint(self):
        """rollback should return None when no checkpoints exist."""
        c = Checkpointer()
        assert c.rollback("g1") is None

    def test_delete_checkpoint(self):
        """delete_checkpoint should remove the checkpoint."""
        c = Checkpointer()
        g = Goal(id="g1", title="Del")
        cp_id = c.create_checkpoint(g)
        assert c.delete_checkpoint(cp_id) is True
        assert c.get_checkpoint(cp_id) is None

    def test_delete_checkpoint_missing(self):
        """delete_checkpoint should return False for unknown ID."""
        c = Checkpointer()
        assert c.delete_checkpoint("missing") is False

    def test_load_from_storage(self):
        """load_from_storage should populate the in-memory index."""
        c = Checkpointer()
        g = Goal(id="g1", title="Load")
        cp = Checkpoint("cp1", "g1", g.to_dict())
        c.load_from_storage([cp])
        assert c.get_checkpoint("cp1") is not None
