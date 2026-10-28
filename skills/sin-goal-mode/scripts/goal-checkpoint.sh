#!/usr/bin/env bash
# Purpose: Create a checkpoint for a goal.
# Docs: goal-checkpoint.sh.doc.md
set -euo pipefail

GOAL_ID=""

usage() {
  echo "Usage: $0 -g GOAL_ID"
  exit 1
}

while getopts "g:h" opt; do
  case $opt in
    g) GOAL_ID="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$GOAL_ID" ]]; then
  usage
fi

python3 -c "
import sys
sys.path.insert(0, 'src')
from sin_goal_mode.server import _init_state, _get_mcp
_init_state()
mcp = _get_mcp()
result = mcp.tools['goal_checkpoint'](goal_id='$GOAL_ID')
print(result)
"
