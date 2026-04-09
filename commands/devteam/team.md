---
name: devteam:team
description: Automated multi-agent pipeline — one command, full lifecycle with optimization feedback loops
argument-hint: "<feature> [--max-loops N] [--skip-spec]"
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
Start the full automated pipeline for a feature using TeamCreate-based multi-agent orchestration. Runs spec → plan → code → review → build → ship → verify with automatic feedback loops.
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
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init team)
```

**Step 2**: Read the skill file and execute it end-to-end:
```bash
SKILL_FILE=$(ls ~/.claude/plugins/cache/devteam/devteam/*/skills/orchestrator.md 2>/dev/null | head -1)
```
Read `$SKILL_FILE` for the full process, then follow it step by step.
</process>
