---
name: devteam:pause
description: Save feature-scoped session state — writes HANDOFF.json and refreshes STATE.md
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Capture the current feature session into .dev/features/<feature>/HANDOFF.json, refresh feature STATE.md, and derive task progress from .dev/features/<feature>/tasks.json for zero-loss resume context.
</objective>

<execution_context>
@../../skills/pause.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVTEAM_BIN" init pause)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init pause --feature $SELECTED)`

**Step 2**: Read the skill file and execute it end-to-end:
```bash
SKILL_FILE=$(ls ~/.claude/plugins/cache/devteam/devteam/*/skills/pause.md 2>/dev/null | head -1)
```
Read `$SKILL_FILE` for the full process, then follow it step by step.
</process>
