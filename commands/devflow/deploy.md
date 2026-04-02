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
@~/.claude/my-dev/workflows/deploy.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the deploy workflow from @~/.claude/my-dev/workflows/deploy.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init deploy`
</process>
