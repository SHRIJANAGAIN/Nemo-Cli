## What changed

<!-- One-paragraph summary. Link the issue with "Fixes #NNN" if there is one. -->

## Why

<!-- The bug, review point, or audit finding this addresses. -->

## Checklist

- [ ] `npx tsc -p tsconfig.check.json --noEmit` passes
- [ ] `npm run lint` passes (no new errors; warnings explained)
- [ ] `npx vitest run` passes (new/changed logic has tests)
- [ ] `npm run format:check` passes
- [ ] No secrets, keys, or tokens in the diff (checked `data/` stays ignored)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` for user-visible changes
- [ ] New tools/hooks carry `timeoutMs`; no `any`, no direct `process.env`
      in core (see AGENTS.md "Review Checklist for Agents")

## Security-sensitive changes

- [ ] Not security-sensitive (approval/sandbox/execpolicy/auth/audit/server/
      workflows) — or, if it is: reasoning reviewed against AGENTS.md
      "Protected Areas" and harness tests cover the deny/ask paths.
