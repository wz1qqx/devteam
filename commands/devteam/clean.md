---
name: devteam:clean
description: Cleanup resources — worktrees, images, K8s resources
argument-hint: "[--dry-run]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---
<objective>
Scan for and optionally remove orphan worktrees, stale container images, and stale K8s pods.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init clean)
```

**Step 2**: Execute:
Scan worktrees (orphans not in any feature scope), images (stale), pods (Error/CrashLoop). Report findings. With --dry-run, only report. Otherwise confirm each category before cleanup.
</process>
