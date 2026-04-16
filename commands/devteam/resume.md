---
name: devteam:resume
description: Restore a feature-scoped session and show current status
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Restore session state from .dev/features/<feature>/HANDOFF.json, STATE.md, context.md, and tasks.json.
</objective>

<execution_context>
@../../skills/resume.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVTEAM_BIN" init resume)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init resume --feature $SELECTED)`

**Step 2**: Read the skill file and execute it end-to-end:
```bash
SKILL_FILE=$(ls ~/.claude/plugins/cache/devteam/devteam/*/skills/resume.md 2>/dev/null | head -1)
```
Read `$SKILL_FILE` for the full process, then follow it step by step.
</process>
