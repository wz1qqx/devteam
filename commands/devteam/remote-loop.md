---
name: devteam:remote-loop
description: Remote validation loop — start, sync, doctor, refresh, record tests, and status for the active track
argument-hint: "<plan|start|doctor|refresh|sync|record-test|status> [--root <path>] [--set <track>] [--feat <feat>] [--run <id>] [--yes] [--branch-patch] [--remote-pytest-log <path>] [--text]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Run the active track's lightweight local-to-remote source/venv validation loop without choosing image or deployment recipes.
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
Run `node "$DEVTEAM_BIN" remote-loop $ARGUMENTS`. plan prints the concrete command sequence for the selected track and optional feature; pass --text for the compact terminal view. The remote venv/env/sync profiles come from the track, while --feat scopes local worktrees and run history to one feature. If the latest open run for that track/feature is stale because worktree HEAD changed, keep start/status visible but use <fresh-run-id> for evidence-writing commands. start creates a no-build/no-deploy run; pass --text to print the new run id plus concrete doctor/sync/record-test follow-up commands. doctor runs env doctor --remote and records env-doctor evidence. refresh only executes with --yes and records env-refresh evidence. sync shows dirty-only sync by default, only applies with --yes, records sync evidence, and accepts --branch-patch when rebuilding the remote mirror from the full branch patch. record-test records local or remote pytest logs with --pytest-log or --remote-pytest-log. status shows compact status for the latest open selected track/feature run; closed and superseded runs are ignored by default. If --run is omitted and the latest open run is stale, mutating/recording subcommands refuse before remote side effects; start a fresh run first and pass its --run id.
</process>
