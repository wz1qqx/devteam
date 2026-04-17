---
name: devteam:init
description: Initialize workspace or add a new feature
argument-hint: "<workspace|feature|bare-metal> [name|flags]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---
<objective>
Bootstrap a new workspace, add a new feature, or scaffold built-in bare-metal rapid-test assets and wire ship.metal defaults for a feature.
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
INIT=$(node "$DEVTEAM_BIN" init workspace)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init workspace --feature $SELECTED)`

**Step 2**: Execute:
Parse action (workspace|feature|bare-metal). WORKSPACE: create workspace.yaml with schema_version 2, create .dev/ directory, configure repos and baselines, set defaults. FEATURE: prompt for name/description/scope, create feature config.yaml, create .dev/features/<name>/ directory, and register the name under defaults.features. BARE-METAL: run `node \"$DEVTEAM_BIN\" init bare-metal --feature <name> [--host user@ip] [--profile <name>] [--config <name>] [--port <port>] [--force] [--no-write-config]` to scaffold `.dev/rapid-test` scripts and profile env.
</process>
