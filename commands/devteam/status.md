---
name: devteam:status
description: Latest run status — one-screen workspace/run overview
argument-hint: "[--root <path>] [--set <track>] [--feat <feat>] [--run <id>] [--json]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Display the latest .devteam/runs/<id>/ status, including workspace state, run evidence, gates, publish plan, and next actions.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover the devteam CLI:
```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
```

If no `--root` is provided, use the current workspace or nearest parent containing `.devteam/config.yaml`. Do not select a global active track; ask the user to choose a track or pass `--set <track>` when the command needs one.

**Step 2**: Execute:
Run `node "$DEVTEAM_BIN" status $ARGUMENTS`. This is a shortcut for session status: if --run is omitted, it reads the latest run whose session metadata still matches current .devteam/config.yaml, skipping malformed or deleted-track history; pass --set and optional --feat to select the latest readable run for one track or feature. By default it prints compact text for daily use; pass --json for the full structured payload. Display phase, latest evidence, workspace totals, sync/image/deploy/deploy-verify/publish gates, publish-after-validation plan, and next_actions.
</process>
