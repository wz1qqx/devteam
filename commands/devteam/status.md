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
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init status)
```

**Step 2**: Execute:
Parse $INIT JSON. Display: active feature, current phase, repos (commits ahead, uncommitted), cluster info, build history, team status if active. Format as dashboard table.
</process>
