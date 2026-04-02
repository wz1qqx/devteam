---
name: devflow:status
description: Project overview - config, worktrees, deployments, pipeline stage
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Display a comprehensive project overview including config, worktree states, active deployments, and pipeline stage.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/info.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the status workflow from @~/.claude/my-dev/workflows/info.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init status`
</process>
