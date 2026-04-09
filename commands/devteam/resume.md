---
name: devteam:resume
description: Restore session state and show current status
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Restore worktree state, active tasks, and pending items from .dev.yaml and state files.
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
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init resume)
```

**Step 2**: Read the skill file and execute it end-to-end:
```bash
SKILL_FILE=$(ls ~/.claude/plugins/cache/devteam/devteam/*/skills/resume.md 2>/dev/null | head -1)
```
Read `$SKILL_FILE` for the full process, then follow it step by step.
</process>
