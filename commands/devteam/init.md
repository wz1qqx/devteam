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
Bootstrap a new workspace (workspace.yaml, directories, baselines) or add a new feature with scope, worktrees, and initial config.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVTEAM_BIN" init workspace)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init workspace --feature $SELECTED)`

**Step 2**: Execute:
Parse action (workspace|feature). WORKSPACE: create workspace.yaml with schema_version 2, create .dev/ directory, configure repos and baselines, set defaults. FEATURE: prompt for name/description/scope, create feature config.yaml, create .dev/features/<name>/ directory, and register the name under defaults.features.
</process>
