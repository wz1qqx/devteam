---
name: devteam:doctor
description: Workspace doctor — checks local worktrees, env/sync readiness, and agent onboarding
argument-hint: "[agent-onboarding] [--root <path>] [--set <track>] [--feat <feat>] [--profile <env-profile>] [--text]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Run the local-to-remote workspace doctor or check that Claude/Codex onboarding is ready for a .devteam workspace.
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
Run `node "$DEVTEAM_BIN" doctor $ARGUMENTS`. Without subcommands, display status, problems, workspace totals, env status, sync totals, run-history health, and next_action. If history has invalid run metadata, review `session archive-plan` before cleaning it up with `session archive --yes`. With `doctor agent-onboarding`, check AGENTS.md, CLAUDE.md, dynamic workspace context, track picker readiness, and devteam-console/devteam-status skill availability; use `workspace onboard --write` to create missing onboarding files.
</process>
