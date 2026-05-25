---
name: devteam:repo
description: Repo management — inspect upstream, branch, dirty, and fetch state
argument-hint: "<list|status|fetch|update-plan> [--root <path>] [--set <track>] [--feat <feat>] [--text]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Inspect configured development repos and worktrees, track upstream drift, fetch remotes explicitly, and plan clean local updates without managing evidence.
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
Run `node "$DEVTEAM_BIN" repo $ARGUMENTS`. Use `repo status --text` as the daily upstream/update view: it reports configured repo remote/upstream URLs, selected worktrees, local branch/head, dirty file counts, base/upstream ref, ahead/behind counts, missing worktrees, and unknown upstream refs. Use `repo list` for configured repo/worktree inventory only. `repo fetch` is the only mutating subcommand; it runs `git fetch --prune` against configured local remotes for selected existing git worktrees. Use it only when the user asks to refresh remote state or when upstream freshness is required. `repo update-plan` prints fetch/rebase commands for clean worktrees that are behind their configured base/upstream ref; it does not execute the update. Track/feature selection follows --set/--feat, DEVTEAM_TRACK/DEVTEAM_FEAT, then workspace defaults.
</process>
