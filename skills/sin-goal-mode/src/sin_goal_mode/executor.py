# Purpose: Execute subtasks by mapping to sin-* tools.
# Docs: executor.doc.md

import subprocess
from typing import Any, Dict, List, Optional
from .goals import Goal, Subtask


class Executor:
    """Executes subtasks by mapping to external sin-* CLI tools."""

    # Mapping of subtask prefixes to CLI commands
    TOOL_MAP: Dict[str, str] = {
        "sin-discover": "discover",
        "sin-map": "map",
        "sin-grasp": "grasp",
        "sin-scout": "scout",
        "sin-execute": "execute",
        "sin-harvest": "harvest",
        "sin-orchestrate": "orchestrate",
    }

    def __init__(self, dry_run: bool = False):
        """Initialize executor. If dry_run is True, commands are logged but not executed."""
        self.dry_run = dry_run
        self._history: List[Dict[str, Any]] = []

    def execute_subtask(self, subtask: Subtask, goal: Optional[Goal] = None) -> Dict[str, Any]:
        """Execute a subtask by inferring the appropriate sin-* tool."""
        command = self._infer_command(subtask)
        result = self._run_command(command, subtask)
        self._history.append({
            "subtask_id": subtask.id,
            "command": command,
            "result": result,
            "goal_id": goal.id if goal else None,
        })
        return result

    def execute_for_goal(self, goal: Goal) -> List[Dict[str, Any]]:
        """Execute all pending subtasks for a goal."""
        results = []
        for st in goal.subtasks:
            if st.status.value == "pending":
                results.append(self.execute_subtask(st, goal))
        return results

    def _infer_command(self, subtask: Subtask) -> List[str]:
        """Infer the CLI command from the subtask title and description."""
        title = subtask.title.lower()
        desc = subtask.description.lower()
        # Default fallback
        matched = False
        tool = "sin_goal_mode_unknown_tool_" + subtask.id
        args = []
        for prefix, binary in self.TOOL_MAP.items():
            if prefix in title or prefix in desc:
                tool = binary
                matched = True
                break
        # Build a basic command line
        cmd = [tool]
        if matched:
            # Heuristic: pass title/description as query/path
            cmd.append("-query")
            cmd.append(subtask.title)
            if subtask.description:
                cmd.append("-path")
                cmd.append(subtask.description)
        return cmd

    def _run_command(self, command: List[str], subtask: Subtask) -> Dict[str, Any]:
        """Run a command and capture its output."""
        if self.dry_run:
            return {
                "success": True,
                "stdout": f"[dry_run] {' '.join(command)}",
                "stderr": "",
                "returncode": 0,
            }
        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=120,
            )
            return {
                "success": proc.returncode == 0,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "returncode": proc.returncode,
            }
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "stdout": "",
                "stderr": "Command timed out after 120s",
                "returncode": -1,
            }
        except Exception as exc:
            return {
                "success": False,
                "stdout": "",
                "stderr": str(exc),
                "returncode": -1,
            }

    def get_history(self) -> List[Dict[str, Any]]:
        """Return the execution history."""
        return list(self._history)
