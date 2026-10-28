# Purpose: SQLite persistence for goals and checkpoints.
# Docs: persistence.doc.md

import json
import sqlite3
from pathlib import Path
from typing import List, Optional
from .goals import Goal, Subtask, SubtaskStatus
from .checkpointer import Checkpoint


class Persistence:
    """SQLite-backed persistence for goals and checkpoints."""

    def __init__(self, db_path: str = "sin_goal_mode.db"):
        """Initialize SQLite connection and ensure tables exist."""
        self.db_path = db_path
        self._ensure_tables()

    def _ensure_tables(self) -> None:
        """Create goals and checkpoints tables if they do not exist."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS goals (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT,
                    status TEXT NOT NULL,
                    subtasks TEXT NOT NULL,
                    checkpoints TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    metadata TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS checkpoints (
                    checkpoint_id TEXT PRIMARY KEY,
                    goal_id TEXT NOT NULL,
                    snapshot TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            conn.commit()

    def save_goal(self, goal: Goal) -> None:
        """Insert or replace a goal record."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO goals
                (id, title, description, status, subtasks, checkpoints, created_at, updated_at, completed_at, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                goal.id,
                goal.title,
                goal.description,
                goal.status.value,
                json.dumps([st.to_dict() for st in goal.subtasks]),
                json.dumps(goal.checkpoints),
                goal.created_at,
                goal.updated_at,
                goal.completed_at,
                json.dumps(goal.metadata),
            ))
            conn.commit()

    def load_goal(self, goal_id: str) -> Optional[Goal]:
        """Load a single goal by its ID."""
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
        if not row:
            return None
        return self._row_to_goal(row)

    def load_all_goals(self) -> List[Goal]:
        """Load all goals from the database."""
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT * FROM goals").fetchall()
        return [self._row_to_goal(row) for row in rows]

    def delete_goal(self, goal_id: str) -> bool:
        """Delete a goal by its ID."""
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
            conn.commit()
            return cur.rowcount > 0

    def save_checkpoint(self, checkpoint: Checkpoint) -> None:
        """Insert or replace a checkpoint record."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO checkpoints
                (checkpoint_id, goal_id, snapshot, created_at)
                VALUES (?, ?, ?, ?)
            """, (
                checkpoint.checkpoint_id,
                checkpoint.goal_id,
                json.dumps(checkpoint.snapshot),
                checkpoint.created_at,
            ))
            conn.commit()

    def load_checkpoint(self, checkpoint_id: str) -> Optional[Checkpoint]:
        """Load a single checkpoint by its ID."""
        with sqlite3.connect(self.db_path) as conn:
            row = conn.execute("SELECT * FROM checkpoints WHERE checkpoint_id = ?", (checkpoint_id,)).fetchone()
        if not row:
            return None
        return self._row_to_checkpoint(row)

    def load_all_checkpoints(self) -> List[Checkpoint]:
        """Load all checkpoints from the database."""
        with sqlite3.connect(self.db_path) as conn:
            rows = conn.execute("SELECT * FROM checkpoints").fetchall()
        return [self._row_to_checkpoint(row) for row in rows]

    def delete_checkpoint(self, checkpoint_id: str) -> bool:
        """Delete a checkpoint by its ID."""
        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute("DELETE FROM checkpoints WHERE checkpoint_id = ?", (checkpoint_id,))
            conn.commit()
            return cur.rowcount > 0

    def _row_to_goal(self, row: tuple) -> Goal:
        """Convert a database row into a Goal object."""
        subtasks = json.loads(row[4])
        return Goal(
            id=row[0],
            title=row[1],
            description=row[2] or "",
            status=row[3],
            subtasks=[Subtask.from_dict(st) for st in subtasks],
            checkpoints=json.loads(row[5]),
            created_at=row[6],
            updated_at=row[7],
            completed_at=row[8],
            metadata=json.loads(row[9]),
        )

    def _row_to_checkpoint(self, row: tuple) -> Checkpoint:
        """Convert a database row into a Checkpoint object."""
        return Checkpoint(
            checkpoint_id=row[0],
            goal_id=row[1],
            snapshot=json.loads(row[2]),
            created_at=row[3],
        )
