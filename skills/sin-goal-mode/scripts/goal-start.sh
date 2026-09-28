#!/usr/bin/env bash
# Purpose: Start a new goal via the goal-mode CLI.
# Docs: goal-start.sh.doc.md
set -euo pipefail

TITLE=""
DESCRIPTION=""
SUBTASKS=""

usage() {
  echo "Usage: $0 -t TITLE [-d DESCRIPTION] [-s SUBTASKS_JSON]"
  exit 1
}

while getopts "t:d:s:h" opt; do
  case $opt in
    t) TITLE="$OPTARG" ;;
    d) DESCRIPTION="$OPTARG" ;;
    s) SUBTASKS="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$TITLE" ]]; then
  usage
fi

# Use Python to invoke the MCP tool via a helper script
python3 -c "
import json, sys, uuid
sys.path.insert(0, 'src')
from sin_goal_mode.server import _init_state, _get_mcp
_init_state()
mcp = _get_mcp()
# Call the tool directly
result = mcp.tools['goal_start'](title='$TITLE', description='${DESCRIPTION:-}', subtasks='${SUBTASKS:-}')
print(result)
"
