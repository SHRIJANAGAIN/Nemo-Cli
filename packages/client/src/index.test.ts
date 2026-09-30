/* Copyright 2026 SKT AI LABS PRIVATE LIMITED. All rights reserved.
 * Trayambak CLI Proprietary License - use, copying, modification, and
 * distribution require a written license agreement with SKT AI LABS
 * PRIVATE LIMITED. See LICENSE for the full terms.
 */

import { describe, it, expect } from "vitest"
import { TrayambakClient } from "./index.js"

describe("TrayambakClient (HTTP)", () => {
  it("constructs with a default base URL", () => {
    // The constructor reads TRAYAMBAK_SERVER_PORT at construction time.
    // When unset it defaults to 8787 — we only assert construction succeeds.
    expect(() => new TrayambakClient()).not.toThrow()
  })
})
