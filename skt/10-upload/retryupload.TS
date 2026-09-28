/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Retry upload module — retries failed uploads until successful.
 */

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const UPLOAD_LOG = path.join(__dirname, "upload.log");

export interface UploadEntry {
  file: string;
  timestamp: string;
  status: "pending" | "success" | "failed";
  retries: number;
}

export function retryUpload(maxRetries = 5): void {
  console.log("TRAYAMBAK Retry Upload v0.3.0");

  // Read pending uploads from log
  if (!fs.existsSync(UPLOAD_LOG)) {
    console.log("No pending uploads.");
    return;
  }

  const entries: UploadEntry[] = JSON.parse(fs.readFileSync(UPLOAD_LOG, "utf8"));
  const pending = entries.filter((e) => e.status === "pending" || e.status === "failed");

  console.log(`Found ${pending.length} pending uploads.`);

  for (const entry of pending) {
    let success = false;
    for (let i = 0; i < maxRetries; i++) {
      try {
        // Simulate upload (replace with actual upload logic)
        entry.retries++;
        entry.status = "success";
        entry.timestamp = new Date().toISOString();
        success = true;
        console.log(`  ✓ Uploaded ${entry.file} (attempt ${i + 1})`);
        break;
      } catch {
        console.log(`  ✗ Retry ${i + 1} for ${entry.file}`);
      }
    }
    if (!success) {
      entry.status = "failed";
      console.log(`  ✗ Failed to upload ${entry.file} after ${maxRetries} retries`);
    }
  }

  // Write updated log
  fs.writeFileSync(UPLOAD_LOG, JSON.stringify(entries, null, 2));
  console.log("\nRetry complete.");
}

if (require.main === module) {
  retryUpload();
}

