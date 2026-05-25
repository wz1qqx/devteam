---
name: devteam:status
description: Harness status — one-screen workspace/repo/env overview
argument-hint: "[--root <path>] [--set <track>] [--feat <feat>] [--json] [--session|--run <id>]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Display the workspace harness state: selected track/feature, local worktrees, repo/upstream drift, environment/runtime binding, sync state, presence, and recent runs.
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
Run `node "$DEVTEAM_BIN" status $ARGUMENTS`. This is the harness daily status, not a required evidence gate: it summarizes selected track/feature, worktree present/dirty/missing counts, repo upstream behind/unknown counts, effective environment/profile/runtime exports, stable runtime binding state, proxy availability, last sync state, active presence, and latest run summary when one exists. If no current binding exists, follow the suggested `env bind --text` command before opening remote or K8s helper sessions; when binding is current, source the printed `.devteam/state/runtime-*.sh` file. By default it prints compact text; pass --json for the structured payload. Use `status --session`, `status --run <id>`, or `session status` only when the user explicitly wants the older run/evidence/gate view.
</process>
