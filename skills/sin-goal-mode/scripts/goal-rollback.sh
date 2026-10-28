#!/usr/bin/env bash
# Purpose: Rollback a goal to its last checkpoint.
# Docs: goal-rollback.sh.doc.md
set -euo pipefail

GOAL_ID=""
CHECKPOINT_ID=""

usage() {
  echo "Usage: $0 -g GOAL_ID [-c CHECKPOINT_ID]"
  exit 1
}

while getopts "g:c:h" opt; do
  case $opt in
    g) GOAL_ID="$OPTARG" ;;
    c) CHECKPOINT_ID="$OPTARG" ;;
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
result = mcp.tools['goal_rollback'](goal_id='$GOAL_ID', checkpoint_id='${CHECKPOINT_ID:-}')
print(result)
"
