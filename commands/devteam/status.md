---
name: devteam:status
description: Project overview — team status, pipeline stage, deployments
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Display a comprehensive project overview including config, worktree states, active deployments, and pipeline stage.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
INIT=$(node "$DEVTEAM_BIN" init status)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init status --feature $SELECTED)`

**Step 2**: Execute:
Parse $INIT JSON. Display: selected feature if one is resolved, current phase, repos (commits ahead, uncommitted), cluster info, build history, team status if active. Format as dashboard table.
</process>
