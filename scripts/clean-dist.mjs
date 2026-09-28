/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - see LICENSE for the full terms.
 */

/**
 * Remove dist/ and stray tsbuildinfo files BEFORE a build.
 *
 * Why: tsc never deletes outputs for sources that were deleted/renamed,
 * so a dirty dist/ keeps serving months-old commands (this actually
 * happened: dist shipped 0.3.0 while src was 0.5.0). Every build now
 * starts from a clean slate, making "stale dist" structurally impossible
 * after a successful build.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true, force: true });
  console.log("clean-dist: removed dist/");
}

for (const entry of fs.readdirSync(ROOT)) {
  if (entry.endsWith(".tsbuildinfo")) {
    fs.rmSync(path.join(ROOT, entry), { force: true });
    console.log(`clean-dist: removed ${entry}`);
  }
}
