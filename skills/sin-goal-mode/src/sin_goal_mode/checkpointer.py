# Purpose: Create and restore checkpoints for goal state snapshots.
# Docs: checkpointer.doc.md

import json
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional
from .goals import Goal


class Checkpoint:
    """Represents a snapshot of a goal at a point in time."""

    def __init__(self, checkpoint_id: str, goal_id: str, snapshot: dict, created_at: str = None):
        """Initialize a checkpoint with a goal snapshot."""
        self.checkpoint_id = checkpoint_id
        self.goal_id = goal_id
        self.snapshot = snapshot
        self.created_at = created_at or datetime.now().isoformat()

    def to_dict(self) -> dict:
        """Serialize checkpoint to a dictionary."""
        return {
            "checkpoint_id": self.checkpoint_id,
            "goal_id": self.goal_id,
            "snapshot": self.snapshot,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Checkpoint":
        """Deserialize checkpoint from a dictionary."""
        return cls(
            checkpoint_id=data["checkpoint_id"],
            goal_id=data["goal_id"],
            snapshot=data["snapshot"],
            created_at=data.get("created_at", datetime.now().isoformat()),
        )


class Checkpointer:
    """Manages checkpoint creation and rollback for goals."""

    def __init__(self, persistence=None):
        """Initialize checkpointer with optional persistence layer."""
        self._persistence = persistence
        self._checkpoints: Dict[str, Checkpoint] = {}

    def create_checkpoint(self, goal: Goal) -> str:
        """Create a checkpoint for a goal and return its ID."""
        checkpoint_id = str(uuid.uuid4())
        snapshot = goal.to_dict()
        checkpoint = Checkpoint(
            checkpoint_id=checkpoint_id,
            goal_id=goal.id,
            snapshot=snapshot,
        )
        self._checkpoints[checkpoint_id] = checkpoint
        if self._persistence:
            self._persistence.save_checkpoint(checkpoint)
        return checkpoint_id

    def get_checkpoint(self, checkpoint_id: str) -> Optional[Checkpoint]:
        """Retrieve a checkpoint by its ID."""
        return self._checkpoints.get(checkpoint_id)

    def list_checkpoints(self, goal_id: str) -> List[Checkpoint]:
        """List all checkpoints for a given goal."""
        return [cp for cp in self._checkpoints.values() if cp.goal_id == goal_id]

    def get_latest_checkpoint(self, goal_id: str) -> Optional[Checkpoint]:
        """Return the most recent checkpoint for a goal."""
        cps = self.list_checkpoints(goal_id)
        if not cps:
            return None
        return max(cps, key=lambda cp: cp.created_at)

    def rollback(self, goal_id: str, checkpoint_id: Optional[str] = None) -> Optional[Goal]:
        """Restore a goal from a checkpoint. If no checkpoint_id is given, uses the latest."""
        if checkpoint_id:
            cp = self.get_checkpoint(checkpoint_id)
        else:
            cp = self.get_latest_checkpoint(goal_id)
        if not cp or cp.goal_id != goal_id:
            return None
        restored = Goal.from_dict(cp.snapshot)
        restored.mark_rolled_back()
        return restored

    def delete_checkpoint(self, checkpoint_id: str) -> bool:
        """Delete a checkpoint by ID."""
        if checkpoint_id in self._checkpoints:
            del self._checkpoints[checkpoint_id]
            if self._persistence:
                self._persistence.delete_checkpoint(checkpoint_id)
            return True
        return False

    def load_from_storage(self, checkpoints: List[Checkpoint]) -> None:
        """Load checkpoints from external storage into memory."""
        for cp in checkpoints:
            self._checkpoints[cp.checkpoint_id] = cp
