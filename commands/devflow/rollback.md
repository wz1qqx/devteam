---
name: devflow:rollback
description: Rollback deployment to a previous image tag
argument-hint: "[tag]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - AskUserQuestion
---
<objective>
Rollback a K8s deployment to a previous image tag from build history.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/rollback.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the rollback workflow from @~/.claude/my-dev/workflows/rollback.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init rollback`
</process>
