---
name: devteam:cluster
description: Manage Kubernetes clusters — add, use, list
argument-hint: "<add|use|list> [name]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - AskUserQuestion
---
<objective>
Manage cluster profiles in workspace.yaml.
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
INIT=$(node "$DEVTEAM_BIN" init cluster)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init cluster --feature $SELECTED)`

**Step 2**: Execute:
Parse action (add/use/list). LIST: show clusters + active. USE: switch active_cluster. ADD: interactive cluster config collection (ssh, namespace, safety, hardware), save to workspace.yaml.
</process>
