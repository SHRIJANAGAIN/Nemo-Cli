# Import Memory from Other Coding Agents

# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

## Overview

Import sessions and memory from other coding agents (Nemo, Nemo Code, Cline, etc.).

## Usage

1. Run `import-memory.py` to import from a specific agent
2. Run `imported-memory.py` to verify the import
3. Run `import.py` to import from a specific session ID

## Supported Agents

- Nemo (.nemo/)
- Nemo Code (.nemo/)
- Cline (.cline/)
- Continue (.continue/)
- Gemini (.gemini/)

## Notes

- Imported memories are stored in `nemo/4-mem/MEMORY.MD`
- Duplicate entries are automatically merged
- Import history is logged in `nemo/8-conversations/`
