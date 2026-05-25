---
name: devteam:ws
description: Workspace inventory — local repo/worktree status
argument-hint: "<status|materialize|publish-plan|publish> [--root <path>] [--set <track>] [--feat <feat>] [--text] [--full] [--limit <n>] [--apply] [--run <id>] [--yes]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Inspect local worktrees from the workspace config and lane files.
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
Run `node "$DEVTEAM_BIN" ws $ARGUMENTS`. Without --feat, status/materialize/publish operate on the track worktrees. With --feat, they operate only on that feature's incremental worktrees while reusing the track-owned profiles and instances. For status, display one row per worktree: id, repo, path, branch, dirty, dirty_file_count, dirty_summary, dirty_files, commits_ahead, exists, source_exists; pass --text for the compact terminal view, --full for the full captured dirty file list, or --limit <n> to cap dirty file lines. For materialize, display planned clone commands; only use --apply when the user explicitly asks to create local clones. For publish-plan, display publish.after_validation worktrees, branch/dirty/remote-ref state, run_gate when --run is passed, blocked_by reasons, and generated git push commands. For publish, dry-run by default, require a ready run gate by default, execute only with --yes, and record publish evidence to the run.
</process>
