"""Tests for Persistence (SQLite save/load/delete for goals and checkpoints).
Docs: test_persistence.doc.md
"""
import os
import pytest
from sin_goal_mode.goals import Goal, Subtask, GoalStatus
from sin_goal_mode.checkpointer import Checkpoint
from sin_goal_mode.persistence import Persistence


class TestPersistence:
    """Cover SQLite CRUD for goals and checkpoints."""

    def setup_method(self):
        """Use a temporary database per test to avoid side effects."""
        self.db_path = "test_persistence.db"
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
        self.p = Persistence(self.db_path)

    def teardown_method(self):
        """Clean up temporary database after each test."""
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_save_and_load_goal(self):
        """save_goal followed by load_goal should reconstruct the object."""
        g = Goal(id="g1", title="Persist", description="desc")
        g.add_subtask(Subtask(id="s1", title="Sub"))
        self.p.save_goal(g)
        loaded = self.p.load_goal("g1")
        assert loaded is not None
        assert loaded.id == "g1"
        assert loaded.title == "Persist"
        assert loaded.description == "desc"
        assert len(loaded.subtasks) == 1

    def test_load_goal_missing(self):
        """load_goal should return None for unknown ID."""
        assert self.p.load_goal("missing") is None

    def test_load_all_goals(self):
        """load_all_goals should return every persisted goal."""
        for i in range(3):
            self.p.save_goal(Goal(id=f"g{i}", title=f"Goal {i}"))
        goals = self.p.load_all_goals()
        assert len(goals) == 3

    def test_delete_goal(self):
        """delete_goal should remove the record."""
        self.p.save_goal(Goal(id="g1", title="Del"))
        assert self.p.delete_goal("g1") is True
        assert self.p.load_goal("g1") is None

    def test_delete_goal_missing(self):
        """delete_goal should return False when ID does not exist."""
        assert self.p.delete_goal("missing") is False

    def test_save_and_load_checkpoint(self):
        """save_checkpoint and load_checkpoint should roundtrip."""
        g = Goal(id="g1", title="CP")
        cp = Checkpoint("cp1", "g1", g.to_dict())
        self.p.save_checkpoint(cp)
        loaded = self.p.load_checkpoint("cp1")
        assert loaded is not None
        assert loaded.checkpoint_id == "cp1"
        assert loaded.goal_id == "g1"
        assert loaded.snapshot["id"] == "g1"

    def test_load_checkpoint_missing(self):
        """load_checkpoint should return None for unknown ID."""
        assert self.p.load_checkpoint("missing") is None

    def test_load_all_checkpoints(self):
        """load_all_checkpoints should return every persisted checkpoint."""
        g = Goal(id="g1", title="CP")
        for i in range(3):
            self.p.save_checkpoint(Checkpoint(f"cp{i}", "g1", g.to_dict()))
        cps = self.p.load_all_checkpoints()
        assert len(cps) == 3

    def test_delete_checkpoint(self):
        """delete_checkpoint should remove the record."""
        g = Goal(id="g1", title="Del CP")
        cp = Checkpoint("cp1", "g1", g.to_dict())
        self.p.save_checkpoint(cp)
        assert self.p.delete_checkpoint("cp1") is True
        assert self.p.load_checkpoint("cp1") is None

    def test_delete_checkpoint_missing(self):
        """delete_checkpoint should return False when ID does not exist."""
        assert self.p.delete_checkpoint("missing") is False

    def test_update_existing_goal(self):
        """Saving a goal twice should update the record."""
        g = Goal(id="g1", title="First")
        self.p.save_goal(g)
        g.title = "Second"
        self.p.save_goal(g)
        loaded = self.p.load_goal("g1")
        assert loaded.title == "Second"

    def test_persistence_with_metadata(self):
        """Goals with metadata should serialize correctly."""
        g = Goal(id="g1", title="Meta", metadata={"key": "value", "num": 42})
        self.p.save_goal(g)
        loaded = self.p.load_goal("g1")
        assert loaded.metadata == {"key": "value", "num": 42}

    def test_persistence_with_completed_at(self):
        """Goals with completed_at should roundtrip."""
        g = Goal(id="g1", title="Done")
        g.mark_completed()
        self.p.save_goal(g)
        loaded = self.p.load_goal("g1")
        assert loaded.completed_at == g.completed_at

    def test_persistence_with_subtask_status(self):
        """Subtask statuses should roundtrip."""
        g = Goal(id="g1", title="Subs")
        s1 = Subtask(id="s1", title="A")
        s1.mark_completed()
        g.add_subtask(s1)
        g.add_subtask(Subtask(id="s2", title="B"))
        self.p.save_goal(g)
        loaded = self.p.load_goal("g1")
        assert loaded.subtasks[0].status.value == "completed"
        assert loaded.subtasks[1].status.value == "pending"
