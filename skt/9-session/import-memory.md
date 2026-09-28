# Import Memory from Other Coding Agents

# Copyright 2026 SKT AI LABS PRIVATE LIMITED

# Trayambak CLI Proprietary License — see LICENSE for the full terms.

## Overview

Import sessions and memory from other coding agents (Trayambak, Trayambak Code, Cline, etc.).

## Usage

1. Run `import-memory.py` to import from a specific agent
2. Run `imported-memory.py` to verify the import
3. Run `import.py` to import from a specific session ID

## Supported Agents

- Trayambak (.trayambak/)
- Trayambak Code (.trayambak/)
- Cline (.cline/)
- Continue (.continue/)
- Gemini (.gemini/)

## Notes

- Imported memories are stored in `skt/4-mem/MEMORY.MD`
- Duplicate entries are automatically merged
- Import history is logged in `skt/8-conversations/`
