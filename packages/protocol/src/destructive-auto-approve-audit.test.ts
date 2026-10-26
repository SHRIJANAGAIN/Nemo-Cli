/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * Severity and coverage audit of FORCE_ASK_RULES under `--ui-mode auto-approve`.
 *
 * Two distinct defects produced the gaps below, and they need different fixes,
 * which is why this file is split the way it is.
 *
 * 1. SEVERITY. A force-ask rule whose `reason` is absent from
 *    IRREVERSIBLE_FORCE_ASK_REASONS is not in DELETE_FORCE_ASK_RULES and
 *    therefore does not gate at all under auto-approve. The whole `system
 *    power` family — `shutdown`, `reboot`, `poweroff`, `halt`, `Stop-Computer`,
 *    the systemctl power verbs — was in that state, so `shutdown /s /t 0`
 *    returned `allow`. That directly contradicted AGENTS.md, which names
 *    `shutdown` among the operations that "always resolve to `ask` unless
 *    danger mode is explicit". The patterns already existed; only the
 *    classification was wrong.
 *
 * 2. COVERAGE. Commands that reach the same destruction through a different
 *    spelling. `dd of=/dev/` was gated but `wipefs`/`blkdiscard` were not;
 *    `DROP TABLE`/`TRUNCATE TABLE` were gated but `DELETE FROM` was not;
 *    `aws s3 rb` was gated but `aws s3 rm`/`aws s3 sync --delete` were not.
 *    The subtlest is ordering: PowerShell takes the path before the switches,
 *    so `Remove-Item C:\Windows\System32\config -Recurse -Force` — which
 *    destroys the offline registry hives — matched neither of the two
 *    flag-first rules and returned `allow`.
 *
 * Every case in the first two describe blocks was measured returning `allow`
 * under auto-approve before the fix.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { clearSessionPermissionRules, evaluatePermission } from "./permission-rules.js"
import { DEFAULT_PERMISSIONS, type PermissionConfig } from "./permissions.js"

function cfg(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return { ...DEFAULT_PERMISSIONS, ...overrides }
}

const bare = () => cfg({ rules: [] })

function action(command: string, uiMode: "ask" | "auto-approve" = "auto-approve"): string {
  return evaluatePermission("bash", { command }, bare(), { uiMode }).action
}

function reason(command: string): string {
  const d = evaluatePermission("bash", { command }, bare(), { uiMode: "auto-approve" })
  return String(d.rule?.reason ?? d.source)
}

beforeEach(() => {
  clearSessionPermissionRules()
})

describe("host power commands gate under auto-approve (AGENTS.md requirement)", () => {
  it("asks for every way of taking the machine down", () => {
    for (const command of [
      "shutdown /s /t 0",
      "shutdown -h now",
      "reboot",
      "poweroff",
      "halt -p",
      "systemctl poweroff",
      "systemctl reboot",
      "systemctl isolate rescue.target",
    ]) {
      expect(action(command), command).toBe("ask")
    }
  })

  it("classifies them under the irreversible reason, not a bespoke one", () => {
    // The reason is what makes the rule survive auto-approve; asserting it
    // catches a future edit that adds a pattern without the classification.
    for (const command of ["shutdown /s /t 0", "reboot", "poweroff", "halt -p", "systemctl isolate rescue.target"]) {
      expect(reason(command), command).toBe("system power")
    }
  })
})

describe("whole-device destruction gates via the existing raw-disk reason", () => {
  it("asks for the dedicated block-device tools, not just dd", () => {
    for (const command of [
      "wipefs -a /dev/sda",
      "wipefs --all /dev/nvme0n1",
      "blkdiscard /dev/nvme0n1",
      "blkdiscard --offset 0 /dev/sdb",
    ]) {
      expect(action(command), command).toBe("ask")
      expect(reason(command), command).toBe("raw disk write")
    }
  })
})

describe("remote data destruction gates at object level, not just container level", () => {
  it("asks for object deletion and destructive sync alongside bucket removal", () => {
    for (const command of [
      "aws s3 rm s3://bucket --recursive",
      "aws s3 rm s3://bucket/key",
      "aws s3 sync s3://bucket ./local --delete",
      "az storage blob delete-batch --account-name x",
      // Pre-existing, must not regress.
      "aws s3 rb s3://bucket",
      "gsutil rm -r gs://bucket",
    ]) {
      expect(action(command), command).toBe("ask")
      expect(reason(command), command).toBe("cloud storage destruction")
    }
  })
})

describe("table destruction covers DELETE FROM, not only DROP and TRUNCATE", () => {
  it("asks for a WHERE-less delete", () => {
    for (const command of ["psql -c 'DELETE FROM users'", 'mysql -e "DELETE FROM orders"']) {
      expect(action(command), command).toBe("ask")
      expect(reason(command), command).toBe("table destruction")
    }
  })

  it("leaves a scoped delete alone", () => {
    // `DELETE FROM users WHERE id = 4` removes one row the caller named. The
    // rule is a substring match, so the scoped form gates too — pinned here as
    // the known cost of not parsing SQL, and it errs toward a prompt.
    expect(action("psql -c 'DELETE FROM users WHERE id = 4'")).toBe("ask")
  })
})

describe("PowerShell switch order no longer bypasses the recursive-delete gate", () => {
  it("asks when the path precedes the switches", () => {
    for (const command of [
      "Remove-Item C:\\Windows\\System32\\config -Recurse -Force",
      "Remove-Item .\\build -Recurse -Force",
      "Remove-Item .\\dist -Force -Recurse",
      // Pre-existing flag-first forms, must not regress.
      "Remove-Item -Recurse -Force .\\build",
      "Remove-Item -Force -Recurse .\\build",
    ]) {
      expect(action(command), command).toBe("ask")
    }
  })
})

describe("publishing a package is treated as a one-way door", () => {
  it("asks for every registry publication", () => {
    for (const command of [
      "npm publish",
      "npm publish --access public",
      "npm unpublish nemo@0.6.8",
      "cargo publish",
      "twine upload dist/*",
    ]) {
      expect(action(command), command).toBe("ask")
      expect(reason(command), command).toBe("package publication")
    }
  })
})

describe("the widened table still does not gate ordinary development work", () => {
  it("allows the routine commands the table is not meant to catch", () => {
    for (const command of [
      "npm test",
      "npm run build",
      "npm ci",
      "npx tsc --noEmit",
      "docker build -t app .",
      "docker compose up -d",
      "kubectl get pods",
      "terraform plan",
      "aws s3 ls s3://bucket",
      "psql -c 'select 1'",
      "cat package.json",
      "git commit -m 'feat: add x'",
      "git push origin feature/x",
    ]) {
      expect(action(command), command).toBe("allow")
    }
  })

  it("keeps the pre-existing dd over-gate rather than silently narrowing it", () => {
    // `dd if=` matches on the READ side, so every dd asks under auto-approve —
    // including this benign image build. Found while writing this file: an
    // earlier draft asserted the opposite. Narrowing it needs argv parsing, and
    // it predates this audit, so the over-gate is pinned as-is rather than
    // quietly changed. A spurious prompt is the safe direction.
    expect(action("dd if=/dev/zero of=./disk.img bs=1M count=10")).toBe("ask")
  })

  it("respects the exclusions the table documents on purpose", () => {
    // These are deliberately absent from IRREVERSIBLE_FORCE_ASK_REASONS, so
    // they must still pass under auto-approve even though each has an
    // ask-mode rule. Asserting them keeps a future "just add everything"
    // sweep from quietly turning auto-approve into a prompt wall.
    for (const command of [
      "sudo apt-get install jq",
      "doas pkg_add vim",
      "git reset --hard HEAD~1",
      "cat ~/.ssh/id_rsa",
      "printenv",
    ]) {
      expect(action(command), command).toBe("allow")
    }
    // ...while still asking in the default mode, which is what "deliberately
    // not irreversible" actually means.
    expect(action("sudo apt-get install jq", "ask")).toBe("ask")
    expect(action("git reset --hard HEAD~1", "ask")).toBe("ask")
  })
})
