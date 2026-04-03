---
name: devflow:deploy
description: Deploy to Kubernetes cluster
argument-hint: "[--cluster <name>]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---
<objective>
Deploy the current image tag to a K8s cluster with namespace safety and pod readiness verification.
</objective>

<execution_context>
@../../skills/my-dev/stages/deploy.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the deploy stage from @../../skills/my-dev/stages/deploy.md end-to-end.
Load project config via: `node "$DEVFLOW_BIN" init deploy`
</process>
