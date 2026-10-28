#!/usr/bin/env bash
# Purpose: List all goals, optionally filtered by status.
# Docs: goal-list.sh.doc.md
set -euo pipefail

FILTER=""

usage() {
  echo "Usage: $0 [-f FILTER_STATUS]"
  echo "  FILTER_STATUS: active, completed, pending, failed"
  exit 1
}

while getopts "f:h" opt; do
  case $opt in
    f) FILTER="$OPTARG" ;;
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
result = mcp.tools['goal_list'](filter_status='${FILTER:-}')
print(result)
"
