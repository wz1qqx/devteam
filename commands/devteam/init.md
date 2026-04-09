---
name: devteam:init
description: Initialize workspace or add a new feature
argument-hint: "<workspace|feature> [name]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---
<objective>
Bootstrap a new workspace (.dev.yaml, directories, baselines) or add a new feature with scope, worktrees, and initial config.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init workspace)
```

**Step 2**: Execute:
Parse action (workspace|feature). WORKSPACE: create .dev.yaml with schema_version 2, create .dev/ directory, configure repos and baselines, set defaults. FEATURE: prompt for name/description/scope, create feature entry in .dev.yaml, create .dev/features/<name>/ directory, set as active feature.
</process>
