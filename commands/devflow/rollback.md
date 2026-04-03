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
@../../skills/my-dev/stages/rollback.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the rollback stage from @../../skills/my-dev/stages/rollback.md end-to-end.
Load project config via: `node "$DEVFLOW_BIN" init rollback`
</process>
