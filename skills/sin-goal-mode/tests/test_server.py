"""Tests for MCP server tools (goal_start, goal_status, goal_list, etc.).
Docs: test_server.doc.md
"""
import json
import os
import pytest
from sin_goal_mode.server import _init_state, TOOLS
from sin_goal_mode.persistence import Persistence


@pytest.fixture(autouse=True)
def reset_state(tmp_path):
    """Reset global state and use a temp database for each test."""
    import sin_goal_mode.server as server_mod
    db = str(tmp_path / "test.db")
    server_mod._PERSISTENCE = None
    server_mod._TRACKER = None
    server_mod._CHECKPOINTER = None
    server_mod._REPORTER = None
    server_mod._EXECUTOR = None
    _init_state(db)
    yield
    server_mod._PERSISTENCE = None
    server_mod._TRACKER = None
    server_mod._CHECKPOINTER = None
    server_mod._REPORTER = None
    server_mod._EXECUTOR = None
    if os.path.exists(db):
        os.remove(db)


def mcp_tool(name):
    """Return a callable tool from the registry."""
    return TOOLS[name]


class TestGoalStart:
    """Cover goal_start tool."""

    def test_start_basic(self):
        """goal_start should create a new goal and return its ID."""
        result = mcp_tool("goal_start")(title="My Goal", description="desc", subtasks="")
        data = json.loads(result)
        assert "goal_id" in data
        assert data["title"] == "My Goal"
        assert data["status"] == "active"
        assert data["subtasks"] == 0

    def test_start_with_subtasks_json(self):
        """goal_start should parse JSON subtasks list."""
        subtasks = json.dumps([{"title": "A"}, {"title": "B", "description": "d"}])
        result = mcp_tool("goal_start")(title="G", subtasks=subtasks)
        data = json.loads(result)
        assert data["subtasks"] == 2

    def test_start_with_subtasks_string(self):
        """goal_start with a plain string subtasks should create a single subtask."""
        result = mcp_tool("goal_start")(title="G", subtasks="just a string")
        data = json.loads(result)
        assert data["subtasks"] == 1


class TestGoalStatus:
    """Cover goal_status tool."""

    def test_status_basic(self):
        """goal_status should return progress, blockers, and next steps."""
        start = json.loads(mcp_tool("goal_start")(title="G", subtasks='[{"title":"S"}]'))
        gid = start["goal_id"]
        result = mcp_tool("goal_status")(goal_id=gid)
        data = json.loads(result)
        assert data["goal_id"] == gid
        assert "progress_pct" in data
        assert data["blockers"] == []
        assert data["next_steps"] == ["S"]

    def test_status_missing(self):
        """goal_status for missing goal should return an error."""
        result = mcp_tool("goal_status")(goal_id="missing")
        data = json.loads(result)
        assert "error" in data


class TestGoalList:
    """Cover goal_list tool."""

    def test_list_empty(self):
        """goal_list with no goals should return empty list."""
        result = mcp_tool("goal_list")(filter_status="")
        data = json.loads(result)
        assert data["count"] == 0

    def test_list_filter(self):
        """goal_list with filter should return only matching goals."""
        mcp_tool("goal_start")(title="A")
        mcp_tool("goal_start")(title="B")
        result = mcp_tool("goal_list")(filter_status="active")
        data = json.loads(result)
        assert data["count"] == 2


class TestGoalComplete:
    """Cover goal_complete tool."""

    def test_complete(self):
        """goal_complete should mark the goal as completed."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_complete")(goal_id=gid)
        data = json.loads(result)
        assert data["status"] == "completed"
        assert "completed_at" in data

    def test_complete_missing(self):
        """goal_complete for missing goal should return an error."""
        result = mcp_tool("goal_complete")(goal_id="missing")
        data = json.loads(result)
        assert "error" in data


class TestGoalCheckpoint:
    """Cover goal_checkpoint tool."""

    def test_checkpoint(self):
        """goal_checkpoint should create a checkpoint and return its ID."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_checkpoint")(goal_id=gid)
        data = json.loads(result)
        assert "checkpoint_id" in data
        assert data["checkpoint_count"] == 1

    def test_checkpoint_missing(self):
        """goal_checkpoint for missing goal should return an error."""
        result = mcp_tool("goal_checkpoint")(goal_id="missing")
        data = json.loads(result)
        assert "error" in data


class TestGoalRollback:
    """Cover goal_rollback tool."""

    def test_rollback(self):
        """goal_rollback should restore the goal from latest checkpoint."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        mcp_tool("goal_checkpoint")(goal_id=gid)
        mcp_tool("goal_complete")(goal_id=gid)
        result = mcp_tool("goal_rollback")(goal_id=gid)
        data = json.loads(result)
        assert data["status"] == "rolled_back"
        assert data["restored_from"] == "latest"

    def test_rollback_missing(self):
        """goal_rollback for missing goal should return an error."""
        result = mcp_tool("goal_rollback")(goal_id="missing")
        data = json.loads(result)
        assert "error" in data


class TestGoalSubtask:
    """Cover goal_subtask tool (add, remove, complete, block)."""

    def test_add_subtask(self):
        """goal_subtask add should append a new subtask."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_subtask")(goal_id=gid, action="add", title="New Sub")
        data = json.loads(result)
        assert data["action"] == "added"
        assert data["goal_id"] == gid

    def test_remove_subtask(self):
        """goal_subtask remove should delete the subtask."""
        start = json.loads(mcp_tool("goal_start")(title="G", subtasks='[{"id":"s1","title":"S"}]'))
        gid = start["goal_id"]
        result = mcp_tool("goal_subtask")(goal_id=gid, action="remove", subtask_id="s1")
        data = json.loads(result)
        assert data["action"] == "removed"

    def test_complete_subtask(self):
        """goal_subtask complete should mark the subtask completed."""
        start = json.loads(mcp_tool("goal_start")(title="G", subtasks='[{"id":"s1","title":"S"}]'))
        gid = start["goal_id"]
        result = mcp_tool("goal_subtask")(goal_id=gid, action="complete", subtask_id="s1")
        data = json.loads(result)
        assert data["action"] == "completed"

    def test_block_subtask(self):
        """goal_subtask block should mark the subtask blocked."""
        start = json.loads(mcp_tool("goal_start")(title="G", subtasks='[{"id":"s1","title":"S"}]'))
        gid = start["goal_id"]
        result = mcp_tool("goal_subtask")(goal_id=gid, action="block", subtask_id="s1", description="reason")
        data = json.loads(result)
        assert data["action"] == "blocked"

    def test_unknown_action(self):
        """goal_subtask with unknown action should return an error."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_subtask")(goal_id=gid, action="fly", subtask_id="s1")
        data = json.loads(result)
        assert "error" in data

    def test_missing_goal(self):
        """goal_subtask for missing goal should return an error."""
        result = mcp_tool("goal_subtask")(goal_id="missing", action="add", title="T")
        data = json.loads(result)
        assert "error" in data


class TestGoalReport:
    """Cover goal_report tool."""

    def test_report_markdown(self):
        """goal_report should return markdown by default."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_report")(goal_id=gid, format="markdown")
        assert "# Goal: G" in result

    def test_report_json(self):
        """goal_report with format=json should return JSON."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_report")(goal_id=gid, format="json")
        data = json.loads(result)
        assert "goals" in data
        assert "summary" in data

    def test_report_all_goals(self):
        """goal_report without goal_id should return report for all goals."""
        mcp_tool("goal_start")(title="A")
        mcp_tool("goal_start")(title="B")
        result = mcp_tool("goal_report")(goal_id="", format="markdown")
        assert "# Goal Progress Report" in result


class TestErrorHandling:
    """Cover error handling across tools."""

    def test_rollback_no_checkpoint(self):
        """goal_rollback without prior checkpoint should return an error."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_rollback")(goal_id=gid)
        data = json.loads(result)
        assert "error" in data

    def test_complete_subtask_missing(self):
        """goal_subtask complete for missing subtask should return not_found."""
        start = json.loads(mcp_tool("goal_start")(title="G"))
        gid = start["goal_id"]
        result = mcp_tool("goal_subtask")(goal_id=gid, action="complete", subtask_id="missing")
        data = json.loads(result)
        assert data["action"] == "not_found"
