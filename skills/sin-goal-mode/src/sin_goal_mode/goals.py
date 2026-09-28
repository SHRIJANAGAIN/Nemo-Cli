# Purpose: Goal dataclass and status definitions for goal-mode tracking.
# Docs: goals.doc.md

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional


class GoalStatus(Enum):
    """Status enum for a goal lifecycle."""
    PENDING = "pending"
    ACTIVE = "active"
    COMPLETED = "completed"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


class SubtaskStatus(Enum):
    """Status enum for individual subtasks."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    BLOCKED = "blocked"


@dataclass
class Subtask:
    """Represents a single subtask within a goal."""
    id: str
    title: str
    description: str = ""
    status: SubtaskStatus = SubtaskStatus.PENDING
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_at: Optional[str] = None

    def mark_completed(self) -> None:
        """Mark this subtask as completed and record the timestamp."""
        self.status = SubtaskStatus.COMPLETED
        self.completed_at = datetime.now().isoformat()
        self.updated_at = self.completed_at

    def mark_in_progress(self) -> None:
        """Mark this subtask as in progress."""
        self.status = SubtaskStatus.IN_PROGRESS
        self.updated_at = datetime.now().isoformat()

    def mark_blocked(self, reason: str = "") -> None:
        """Mark this subtask as blocked, optionally with a reason."""
        self.status = SubtaskStatus.BLOCKED
        self.description += f" [BLOCKED: {reason}]" if reason else ""
        self.updated_at = datetime.now().isoformat()

    def to_dict(self) -> dict:
        """Serialize subtask to a dictionary."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "status": self.status.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Subtask":
        """Deserialize a subtask from a dictionary."""
        return cls(
            id=data["id"],
            title=data["title"],
            description=data.get("description", ""),
            status=SubtaskStatus(data.get("status", "pending")),
            created_at=data.get("created_at", datetime.now().isoformat()),
            updated_at=data.get("updated_at", datetime.now().isoformat()),
            completed_at=data.get("completed_at"),
        )


@dataclass
class Goal:
    """Represents a tracked goal with subtasks and checkpoints."""
    id: str
    title: str
    description: str = ""
    status: GoalStatus = GoalStatus.PENDING
    subtasks: List[Subtask] = field(default_factory=list)
    checkpoints: List[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_at: Optional[str] = None
    metadata: dict = field(default_factory=dict)

    def add_subtask(self, subtask: Subtask) -> None:
        """Add a new subtask to this goal."""
        self.subtasks.append(subtask)
        self.updated_at = datetime.now().isoformat()

    def remove_subtask(self, subtask_id: str) -> bool:
        """Remove a subtask by ID. Returns True if found and removed."""
        for i, st in enumerate(self.subtasks):
            if st.id == subtask_id:
                self.subtasks.pop(i)
                self.updated_at = datetime.now().isoformat()
                return True
        return False

    def mark_active(self) -> None:
        """Transition goal to active status."""
        self.status = GoalStatus.ACTIVE
        self.updated_at = datetime.now().isoformat()

    def mark_completed(self) -> None:
        """Mark goal as completed and record the timestamp."""
        self.status = GoalStatus.COMPLETED
        self.completed_at = datetime.now().isoformat()
        self.updated_at = self.completed_at

    def mark_failed(self) -> None:
        """Mark goal as failed."""
        self.status = GoalStatus.FAILED
        self.updated_at = datetime.now().isoformat()

    def mark_rolled_back(self) -> None:
        """Mark goal as rolled back after a checkpoint restore."""
        self.status = GoalStatus.ROLLED_BACK
        self.updated_at = datetime.now().isoformat()

    def add_checkpoint(self, checkpoint_id: str) -> None:
        """Record a checkpoint ID on this goal."""
        self.checkpoints.append(checkpoint_id)
        self.updated_at = datetime.now().isoformat()

    def progress_pct(self) -> float:
        """Calculate completion percentage based on subtasks."""
        if not self.subtasks:
            return 0.0 if self.status != GoalStatus.COMPLETED else 100.0
        completed = sum(1 for st in self.subtasks if st.status == SubtaskStatus.COMPLETED)
        return (completed / len(self.subtasks)) * 100.0

    def to_dict(self) -> dict:
        """Serialize goal to a dictionary."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "status": self.status.value,
            "subtasks": [st.to_dict() for st in self.subtasks],
            "checkpoints": self.checkpoints,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Goal":
        """Deserialize a goal from a dictionary."""
        return cls(
            id=data["id"],
            title=data["title"],
            description=data.get("description", ""),
            status=GoalStatus(data.get("status", "pending")),
            subtasks=[Subtask.from_dict(st) for st in data.get("subtasks", [])],
            checkpoints=data.get("checkpoints", []),
            created_at=data.get("created_at", datetime.now().isoformat()),
            updated_at=data.get("updated_at", datetime.now().isoformat()),
            completed_at=data.get("completed_at"),
            metadata=data.get("metadata", {}),
        )
