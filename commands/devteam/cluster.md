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
Manage cluster profiles in .dev.yaml.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init cluster)
```

**Step 2**: Execute:
Parse action (add/use/list). LIST: show clusters + active. USE: switch active_cluster. ADD: interactive cluster config collection (ssh, namespace, safety, hardware), save to .dev.yaml.
</process>
