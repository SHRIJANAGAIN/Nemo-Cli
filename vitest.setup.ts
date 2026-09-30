/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

// Glyph assertions across the TUI suite pin the Unicode set (●/✓/✗/❯).
// Force it here so the suite is deterministic on every OS — including
// legacy Windows consoles where runtime auto-detect would pick ASCII.
process.env.TRAYAMBAK_GLYPHS = "unicode"
