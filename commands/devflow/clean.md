---
name: devflow:clean
description: Cleanup resources - worktrees, images, K8s resources
argument-hint: "[--dry-run]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---
<objective>
Scan for and optionally remove orphan worktrees, stale container images, and stale K8s pods.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/clean.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the clean workflow from @~/.claude/my-dev/workflows/clean.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init clean`
</process>
