---
name: devteam:pause
description: Save session state for later resume — writes HANDOFF.json and updates STATE.md
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Capture the current session state into HANDOFF.json and STATE.md for zero-loss session handoff.
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
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init pause)
```

**Step 2**: Read the skill file and execute it end-to-end:
```bash
SKILL_FILE=$(ls ~/.claude/plugins/cache/devteam/devteam/*/skills/pause.md 2>/dev/null | head -1)
```
Read `$SKILL_FILE` for the full process, then follow it step by step.
</process>
