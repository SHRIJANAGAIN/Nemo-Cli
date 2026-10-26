# Approval

`packages/approval/src/index.ts:17`: allowed/denied command prefixes (deny wins), protected files (`.roomodes`, `.nemo/**`, `AGENTS.md`).
Defaults allow `git log/diff/show`; everything else asks. `validateToolUse` (`packages/core/src/validate.ts:7`) rejects missing required args.
