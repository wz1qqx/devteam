---
name: devflow:observe
description: Observability — deploy monitoring, query metrics, analyze performance
argument-hint: "[--setup|--monitor|--analyze|--query <promql>|--stop]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Manage observability stack including Prometheus monitoring, Grafana dashboards, and metrics analysis.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/observe.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the observe workflow from @~/.claude/my-dev/workflows/observe.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init observe`
</process>
