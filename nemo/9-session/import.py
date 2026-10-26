#!/usr/bin/env python3
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

"""
Import memory from other coding agents.
Supports: Nemo, Nemo Code, Cline, Continue, Gemini, Kimi-code, Ollama, Pi
"""

import json
import os
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
NEMO_ROOT = REPO_ROOT / "nemo"
MEM_FILE = NEMO_ROOT / "4-mem" / "MEMORY.MD"
IMPORT_LOG = NEMO_ROOT / "9-session" / "import-log.json"

# Agent config directories
AGENT_DIRS = {
    "nemo": Path.home() / ".nemo",
    "clinerp": Path.home() / ".clinerp",
    "cline": Path.home() / ".cline",
    "continue": Path.home() / ".continue",
    "gemini": Path.home() / ".gemini",
    "kimi-code": Path.home() / ".kimi-code",
    "ollama": Path.home() / ".ollama",
    "pi": Path.home() / ".pi",
}


def load_existing_memory() -> list:
    """Load existing memory entries."""
    if not MEM_FILE.exists():
        return []
    entries = []
    with open(MEM_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if line.startswith("- "):
                entries.append(line[2:])
    return entries


def import_from_agent(agent: str) -> list:
    """Import memory from a specific agent."""
    agent_dir = AGENT_DIRS.get(agent)
    if not agent_dir or not agent_dir.exists():
        print(f"  ✗ {agent}: directory not found")
        return []

    imported = []
    # Look for memory/session files
    for pattern in ["**/*.json", "**/*.md", "**/*.jsonl"]:
        for file in agent_dir.glob(pattern):
            try:
                with open(file, "r", errors="ignore") as f:
                    content = f.read(1000)  # Read first 1000 chars
                if content.strip():
                    entry = f"[{agent}] {file.name}: {content[:200]}..."
                    imported.append(entry)
            except Exception:
                pass

    print(f"  ✓ {agent}: imported {len(imported)} entries")
    return imported


def main():
    print("NEMO Memory Importer v0.3.0")
    print("=" * 40)

    existing = load_existing_memory()
    print(f"Existing memory entries: {len(existing)}")

    all_imported = []
    for agent in AGENT_DIRS:
        imported = import_from_agent(agent)
        all_imported.extend(imported)

    # Merge and deduplicate
    merged = list(set(existing + all_imported))

    # Write back
    with open(MEM_FILE, "w") as f:
        f.write("# NEMO Memory\n")
        f.write(f"# Imported: {datetime.now().isoformat()}\n\n")
        for entry in merged:
            f.write(f"- {entry}\n")

    # Log import
    log_entry = {
        "timestamp": datetime.now().isoformat(),
        "agents": list(AGENT_DIRS.keys()),
        "imported_count": len(all_imported),
        "total_count": len(merged),
    }
    with open(IMPORT_LOG, "a") as f:
        f.write(json.dumps(log_entry) + "\n")

    print(f"\nImported {len(all_imported)} new entries.")
    print(f"Total memory entries: {len(merged)}")


if __name__ == "__main__":
    main()

