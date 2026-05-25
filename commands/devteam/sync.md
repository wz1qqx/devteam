---
name: devteam:sync
description: Sync planning — local worktrees to remote development environment
argument-hint: "<plan|apply|status> [--root <path>] [--set <track>] [--feat <feat>] [--profile <env-profile>] [--patch-mode <branch-patch|dirty-only>] [--dirty-only] [--branch-patch] [--include-assets] [--yes] [--run <id>]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Generate an explicit rsync plan for local-to-remote development testing.
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
Run `node "$DEVTEAM_BIN" sync plan $ARGUMENTS` unless another subcommand is provided. The sync/env profile is inferred from the selected track; --feat only narrows the worktree set to that feature. Display syncable/missing totals, patch mode, patch file counts, and generated commands. For relative patch sync strategies, branch-patch syncs base_ref..HEAD plus dirty/staged/untracked files and remains the default for sync plan/apply; dirty-only syncs only current working tree, staged, and untracked files for daily incremental validation. `sync apply` is dry-run by default; only pass --yes when the user explicitly asks to execute rsync. With apply --yes --run <id>, append a sync event to that run.
</process>
