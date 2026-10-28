"""Tests for Reporter (Markdown and JSON report generation).
Docs: test_reporter.doc.md
"""
import pytest
from sin_goal_mode.goals import Goal, Subtask, GoalStatus
from sin_goal_mode.reporter import Reporter


class TestReporter:
    """Cover full report, single goal report, and summary generation."""

    def test_empty_report(self):
        """Reporter with no goals should produce a summary with zero counts."""
        r = Reporter([])
        report = r.generate_report()
        assert "0 total" in report or "Total goals: 0" in report

    def test_full_report_active(self):
        """Active goal should appear in the Active Goals section."""
        g = Goal(id="g1", title="Active", status=GoalStatus.ACTIVE)
        g.add_subtask(Subtask(id="s1", title="Sub"))
        r = Reporter([g])
        report = r.generate_report()
        assert "Active Goals" in report
        assert "Active" in report

    def test_full_report_completed(self):
        """Completed goal should appear in the Completed Goals section."""
        g = Goal(id="g1", title="Done", status=GoalStatus.COMPLETED)
        g.mark_completed()
        r = Reporter([g])
        report = r.generate_report()
        assert "Completed Goals" in report
        assert "Done" in report

    def test_full_report_pending(self):
        """Pending goal should appear in the Pending Goals section."""
        g = Goal(id="g1", title="Wait", status=GoalStatus.PENDING)
        r = Reporter([g])
        report = r.generate_report()
        assert "Pending Goals" in report
        assert "Wait" in report

    def test_full_report_failed(self):
        """Failed goal should appear in the Failed Goals section."""
        g = Goal(id="g1", title="Fail", status=GoalStatus.FAILED)
        r = Reporter([g])
        report = r.generate_report()
        assert "Failed Goals" in report
        assert "Fail" in report

    def test_single_goal_report(self):
        """generate_report with a goal_id should produce a detailed report."""
        g = Goal(id="g1", title="Detail", description="A description")
        g.add_subtask(Subtask(id="s1", title="Sub1"))
        g.add_subtask(Subtask(id="s2", title="Sub2"))
        r = Reporter([g])
        report = r.generate_report("g1")
        assert "Detail" in report
        assert "A description" in report
        assert "Sub1" in report
        assert "Sub2" in report

    def test_single_goal_report_not_found(self):
        """generate_report for missing goal_id should indicate not found."""
        r = Reporter([])
        report = r.generate_report("missing")
        assert "not found" in report

    def test_single_goal_report_with_blockers(self):
        """Blocked subtasks should be listed in a Blockers section."""
        g = Goal(id="g1", title="Block")
        s = Subtask(id="s1", title="Blocked Sub")
        s.mark_blocked("error")
        g.add_subtask(s)
        r = Reporter([g])
        report = r.generate_report("g1")
        assert "Blockers" in report
        assert "Blocked Sub" in report

    def test_single_goal_report_with_checkpoints(self):
        """Checkpoints should be listed in a Checkpoints section."""
        g = Goal(id="g1", title="Checkpoints")
        g.add_checkpoint("cp1")
        g.add_checkpoint("cp2")
        r = Reporter([g])
        report = r.generate_report("g1")
        assert "Checkpoints" in report
        assert "cp1" in report
        assert "cp2" in report

    def test_summary(self):
        """generate_summary should return a concise count string."""
        g1 = Goal(id="g1", title="A", status=GoalStatus.COMPLETED)
        g2 = Goal(id="g2", title="B", status=GoalStatus.ACTIVE)
        g3 = Goal(id="g3", title="C", status=GoalStatus.PENDING)
        r = Reporter([g1, g2, g3])
        summary = r.generate_summary()
        assert "1/3 completed" in summary
        assert "1 active" in summary

    def test_report_with_completed_at(self):
        """Completed goal should show completed_at in the report."""
        g = Goal(id="g1", title="Done")
        g.mark_completed()
        r = Reporter([g])
        report = r.generate_report("g1")
        assert "Completed:" in report

    def test_report_with_progress(self):
        """Report should include the progress percentage."""
        g = Goal(id="g1", title="Prog")
        g.add_subtask(Subtask(id="s1", title="A"))
        g.add_subtask(Subtask(id="s2", title="B"))
        g.subtasks[0].mark_completed()
        r = Reporter([g])
        report = r.generate_report("g1")
        assert "50.0%" in report
