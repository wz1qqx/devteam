---
name: devteam:presence
description: Session presence — soft-lock hints for concurrent track work
argument-hint: "<list|touch|clear> [--root <path>] [--set <track>] [--feat <feat>] [--session-id <id>] [--purpose <text>] [--run <id>] [--ttl-seconds <n>] [--text] [--yes]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Record and inspect lightweight active-session presence under .devteam/presence without blocking work.
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
Run `node "$DEVTEAM_BIN" presence $ARGUMENTS`. touch writes/refreshes .devteam/presence/<session-id>.json for the selected track and optional feature with optional run and purpose. list shows active entries grouped by track or track/feature; pass --all to include expired entries and --ttl-seconds to override the default 45 minute TTL. clear is dry-run by default and removes selected or expired entries only with --yes. Presence is a soft-lock hint only; it never blocks sync, record, build, publish, or deploy.
</process>
