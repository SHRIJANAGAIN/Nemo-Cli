"""Tests for Executor (dry-run, command inference, subtask execution).
Docs: test_executor.doc.md
"""
import pytest
from sin_goal_mode.goals import Goal, Subtask
from sin_goal_mode.executor import Executor


class TestExecutor:
    """Cover dry-run, command inference, and execution history."""

    def test_dry_run_returns_command_string(self):
        """Dry-run mode should return the command string without executing."""
        e = Executor(dry_run=True)
        st = Subtask(id="s1", title="sin-discover find files")
        result = e.execute_subtask(st)
        assert result["success"] is True
        assert "discover" in result["stdout"]

    def test_infer_command_unknown_tool(self):
        """Unknown tool prefix should fallback to echo."""
        e = Executor(dry_run=True)
        st = Subtask(id="s1", title="do something random")
        result = e.execute_subtask(st)
        assert result["success"] is True
        assert "sin_goal_mode_unknown_tool" in result["stdout"] or "no tool matched" in result["stdout"]

    def test_infer_command_map(self):
        """Title containing sin-map should map to the map tool."""
        e = Executor(dry_run=True)
        st = Subtask(id="s1", title="sin-map analyze project")
        result = e.execute_subtask(st)
        assert "map" in result["stdout"]

    def test_infer_command_scout(self):
        """Title containing sin-scout should map to the scout tool."""
        e = Executor(dry_run=True)
        st = Subtask(id="s1", title="sin-scout search pattern")
        result = e.execute_subtask(st)
        assert "scout" in result["stdout"]

    def test_execute_for_goal(self):
        """execute_for_goal should process all pending subtasks."""
        e = Executor(dry_run=True)
        g = Goal(id="g1", title="Run")
        g.add_subtask(Subtask(id="s1", title="sin-discover step1"))
        g.add_subtask(Subtask(id="s2", title="sin-map step2"))
        results = e.execute_for_goal(g)
        assert len(results) == 2
        assert all(r["success"] for r in results)

    def test_history_recorded(self):
        """Execution history should record subtask_id and command."""
        e = Executor(dry_run=True)
        st = Subtask(id="s1", title="sin-discover test")
        g = Goal(id="g1", title="Hist")
        e.execute_subtask(st, g)
        hist = e.get_history()
        assert len(hist) == 1
        assert hist[0]["subtask_id"] == "s1"
        assert hist[0]["goal_id"] == "g1"

    def test_history_empty(self):
        """History should be empty before any execution."""
        e = Executor(dry_run=True)
        assert e.get_history() == []

    def test_dry_run_no_side_effects(self):
        """Dry-run should not execute real commands (returncode 0)."""
        e = Executor(dry_run=True)
        st = Subtask(id="s1", title="sin-execute rm -rf /")
        result = e.execute_subtask(st)
        assert result["returncode"] == 0
        assert "rm" in result["stdout"]

    def test_real_command_success(self):
        """Real execution of a safe command should succeed."""
        e = Executor(dry_run=False)
        st = Subtask(id="s1", title="echo hello")
        # Override inference to use a real command
        e.TOOL_MAP = {"echo": "echo"}
        result = e.execute_subtask(st)
        assert result["success"] is True
        assert "hello" in result["stdout"]

    def test_real_command_failure(self):
        """Real execution of a nonexistent command should fail."""
        e = Executor(dry_run=False)
        st = Subtask(id="s1", title="nonexistent_command_xyz")
        result = e.execute_subtask(st)
        assert result["success"] is False
        assert result["returncode"] != 0
