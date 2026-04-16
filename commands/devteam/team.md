---
name: devteam:team
description: Automated multi-agent pipeline — configurable stages with optimization feedback loops
argument-hint: "<feature> [--stages spec,plan,code,...] [--max-loops N]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---
<objective>
Start the automated pipeline for a feature. Select stages with --stages (default all). Supports checkpoint resume if interrupted, with a frozen `RUN.json` snapshot and explicit dirty-worktree gating before execution.
</objective>

<execution_context>
@../../skills/orchestrator.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVTEAM_BIN" init team)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init team --feature $SELECTED)`

**Step 2**: Read the skill file and execute it end-to-end:
```bash
SKILL_FILE=$(ls ~/.claude/plugins/cache/devteam/devteam/*/skills/orchestrator.md 2>/dev/null | head -1)
```
Read `$SKILL_FILE` for the full process, then follow it step by step.
</process>
