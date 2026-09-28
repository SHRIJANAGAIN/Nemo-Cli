#!/usr/bin/env bash
# Purpose: Generate a progress report for a goal or all goals.
# Docs: goal-report.sh.doc.md
set -euo pipefail

GOAL_ID=""
FORMAT="markdown"

usage() {
  echo "Usage: $0 [-g GOAL_ID] [-f FORMAT]"
  echo "  FORMAT: markdown | json"
  exit 1
}

while getopts "g:f:h" opt; do
  case $opt in
    g) GOAL_ID="$OPTARG" ;;
    f) FORMAT="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

python3 -c "
import sys
sys.path.insert(0, 'src')
from sin_goal_mode.server import _init_state, _get_mcp
_init_state()
mcp = _get_mcp()
result = mcp.tools['goal_report'](goal_id='${GOAL_ID:-}', format='$FORMAT')
print(result)
"
