---
name: devflow:debug
description: Investigation mode - structured debugging with context gathering
argument-hint: "[topic]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebSearch
  - Agent
---
<objective>
Enter structured investigation mode to diagnose issues with hypothesis tracking and experience persistence.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/debug.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the debug workflow from @~/.claude/my-dev/workflows/debug.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init debug`
</process>
