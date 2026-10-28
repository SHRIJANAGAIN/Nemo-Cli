---
name: configure-ecc
description: Guide ECC installation, update, or reconfiguration from inside Nemo Code, Nemo Code, or Kimi while respecting each harness's real plugin, scope, and hook capabilities.
metadata:
  origin: ECC
---

# Configure Everything Nemo Code

Run a conversational wizard inside the current harness. Inventory first, collect
only supported choices, preview, confirm once, apply non-interactively, verify,
and show the welcome only after success. Never clone ECC into a temporary
directory or copy plugin components by hand.

For a human-operated terminal, the canonical entry points are `ecc setup` and
`npx ecc-universal setup`. Inside a harness, use the explicit non-interactive
commands below instead.

## Route by the current harness

- In Nemo Code, use the full scope-and-hook wizard below.
- In Nemo Code, use Nemo Code's native plugin lifecycle. Do not offer Nemo scopes or
  map ECC's four Nemo hook profiles onto Nemo Code.
- In Kimi, install the project surface under `./.kimi-code`. Kimi does not
  provide ECC's Nemo lifecycle-hook profiles.
- If the harness is uncertain, state the detected evidence and ask which
  harness to configure before running a mutating command.

This skill is a post-install reconfiguration path. It cannot intercept or
replace a provider's built-in first-install UI.

## Nemo Code: run the full conversational wizard

### 1. Inventory without changing anything

Run both commands and summarize the installed ECC scope, enabled state, and
marketplace source:

```bash
nemo plugin list --json
nemo plugin marketplace list --json
```

Treat a single existing `ecc@ecc` installation as a reconfiguration. Do not
interpret Nemo's provider-owned "Open home page" control as installation
evidence. Stop and report the recovery returned by setup for multiple ECC
scopes, a legacy/manual install, malformed settings, or a marketplace collision;
never guess which state to delete.

### 2. Collect exactly two choices

Ask exactly one scope question and require one value:

- `user | project | local`
- `user` is global for this user.
- `project` is shared through repository settings.
- `local` is private to the current project.

Visually mark only the selected scope as selected or installing. If the user
chooses a different scope from a single existing install, describe it as a
scope migration and include `--move-scope` in the commands below.

Ask exactly one hook-mode question and require one value:

- `off | minimal | standard | strict`
- `off` keeps skills and commands but disables ECC hook automation.
- `minimal` enables the lightest lifecycle and safety automation.
- `standard` balances quality and safety automation.
- `strict` enables the strongest checks and reminders.

Hook preference is personal Nemo plugin configuration; it does not follow
the selected install scope.

### 3. Preview and confirm once

Prefer the plugin-bundled setup script. Substitute the two selected values and
include `--move-scope` only for a scope migration:

```bash
node "$NEMO_PLUGIN_ROOT/scripts/setup.js" --mode nemo-plugin \
  --scope <scope> --hooks <hooks> [--move-scope] --dry-run --json
```

If `$NEMO_PLUGIN_ROOT` is unavailable, use the published npm package:

```bash
npx --yes --package ecc-universal ecc setup --mode nemo-plugin \
  --scope <scope> --hooks <hooks> [--move-scope] --dry-run --json
```

Show exactly one confirmation summary containing the planned action, one scope,
one hook mode, marketplace action, and any source-to-destination migration.
Ask one yes/no question. Do not run a bare interactive `ecc setup` through a
harness shell tool because that shell is commonly non-TTY.

### 4. Apply the explicit choices

After confirmation, rerun the same route without `--dry-run`. Keep every choice
explicit and request JSON so success can be checked deterministically:

```bash
node "$NEMO_PLUGIN_ROOT/scripts/setup.js" --mode nemo-plugin \
  --scope <scope> --hooks <hooks> [--move-scope] --yes --json
```

Fallback:

```bash
npx --yes --package ecc-universal ecc setup --mode nemo-plugin \
  --scope <scope> --hooks <hooks> [--move-scope] --yes --json
```

### 5. Verify, then render the welcome

Require a zero exit status and a setup result whose `scope` and `hooks` equal
the selected values. Then independently run:

```bash
nemo plugin list --json
```

Continue only when exactly one enabled `ecc@ecc` entry exists at the selected
scope. When `$NEMO_PLUGIN_ROOT` is available, pass the successful setup
`action` (`installed`, `updated`, `migrated`, `resumed`, or
`already-migrated`) to the bundled renderer:

Before invoking it, require the provider-reported version to match
`ECC_VERSION_PATTERN` from `scripts/lib/terminal-welcome.js`. Reject unexpected
version text instead of interpolating it into a shell command.

```bash
node -e 'const { renderTerminalWelcome } = require(process.env.NEMO_PLUGIN_ROOT + "/scripts/lib/terminal-welcome"); process.stdout.write(renderTerminalWelcome({ action: process.argv[1], version: process.argv[2], color: process.stdout.isTTY }));' "<action>" "<installed-version>"
```

Render the welcome exactly once. On failure, dry-run, cancellation, a scope or
hook mismatch, or unverifiable state, do not render it; report the error and
recovery instead. After verified changes, tell the user to run
`/reload-plugins` or restart Nemo Code.

## Nemo Code: use the native plugin lifecycle

Inventory with `nemo plugin marketplace list --json` and
`nemo plugin list --available --json`. Nemo Code's native plugin command has no
Nemo-style `user | project | local` selector. Nemo Code native plugins do support
provider-specific hooks, but Nemo Code requires explicit trust for them. Let Nemo Code
show that trust decision; do not ask the Nemo four-profile hook question or
claim those profiles map to Nemo Code.

If the ECC marketplace is missing, add it. Otherwise refresh its snapshot:

```bash
nemo plugin marketplace add affaan-m/ECC
nemo plugin marketplace upgrade ecc --json
```

Ask for one confirmation, then install or idempotently refresh the installed
cache and verify it:

```bash
nemo plugin add ecc@ecc --json
nemo plugin list --json
```

Continue only when the JSON reports ECC installed and provides its
`installedPath`. Then render the verified bundle's welcome:

Use only the exact absolute `installedPath` returned by Nemo Code JSON. Reject
control characters and require the installed version to match
`ECC_VERSION_PATTERN`. Invoke `node` directly with this argument array; this is
a tool API invocation, not a shell command:

```text
["<installedPath>/scripts/welcome.js", "--action", "configured", "--version", "<installed-version>"]
```

If the current harness cannot invoke an executable with a separate argument
array, skip the welcome. Never construct a shell command from Nemo Code JSON values.

Never claim that Nemo's `off | minimal | standard | strict` profiles were
applied to Nemo Code.

## Kimi: install the project surface

State the capability summary before confirmation: destination
`./.kimi-code`; `hooks=unsupported` for ECC lifecycle hooks. Do not ask the
Nemo scope or hook-mode questions. Preview first:

```bash
npx --yes --package ecc-universal ecc install --profile core --target kimi --dry-run
```

Show one confirmation for that project destination, then apply the identical
command without `--dry-run`. Verify with:

```bash
npx --yes --package ecc-universal ecc doctor --target kimi
```

Only after doctor succeeds and the installed instructions and skills remain
inside `./.kimi-code`, render:

```bash
npx --yes --package ecc-universal ecc welcome --action configured
```

Do not claim that Kimi installed or configured ECC lifecycle hooks.
