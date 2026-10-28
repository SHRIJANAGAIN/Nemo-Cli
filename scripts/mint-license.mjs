/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Mint 16-letter activation codes (NEMO-side only — customers never see this).
 *
 *   node scripts/mint-license.mjs --plan pro --days 365 --secret <check-key>
 *
 * --days is a human duration from today (converted to key-epoch days here,
 * so the minted code actually lasts that long).
 *
 * Prints one 1102-XXXX-XXXX-XXXX code. The check key lives in
 * apps/runtime/src/license.ts (ACTIVATION_CHECK_KEY) — but the code only
 * VERIFIES after the server registers its id (/admin/mint does both).
 * Requires `npm run build` first (imports dist output).
 */

import { mintActivationKey } from "../dist/apps/runtime/src/license.js";
import { activationEpochDays } from "../dist/apps/runtime/src/license.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const plan = flag("--plan") ?? "";
const days = Number(flag("--days") ?? "365");
const secret = flag("--secret") ?? "";

if (!["basic", "pro", "enterprise"].includes(plan)) {
  console.error("usage: node scripts/mint-license.mjs --plan <basic|pro|enterprise> --days <n> --secret <check-key>");
  process.exit(1);
}
if (!secret) {
  console.error("missing --secret (ACTIVATION_CHECK_KEY from apps/runtime/src/license.ts)");
  process.exit(1);
}
if (!Number.isFinite(days) || days < 1 || days > 3650) {
  console.error("--days must be 1..3650 (duration from today)");
  process.exit(1);
}

const todayDays = Math.floor(Date.now() / 86400000);
console.log(mintActivationKey({ plan, expDays: todayDays - activationEpochDays() + Math.floor(days) }, secret));
