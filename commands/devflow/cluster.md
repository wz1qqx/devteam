---
name: devflow:cluster
description: Manage Kubernetes clusters - add, use, list
argument-hint: "<add|use|list> [name]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
---
<objective>
Manage cluster profiles in .dev.yaml. Add new clusters, switch active cluster, or list available ones.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/cluster.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the cluster workflow from @~/.claude/my-dev/workflows/cluster.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init cluster`
</process>
