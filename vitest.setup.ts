/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

// Glyph assertions across the TUI suite pin the Unicode set (●/✓/✗/❯).
// Force it here so the suite is deterministic on every OS — including
// legacy Windows consoles where runtime auto-detect would pick ASCII.
process.env.NEMO_GLYPHS = "unicode"
