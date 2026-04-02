---
name: devflow:quick
description: Execute ad-hoc task with atomic commits — skip full spec/plan ceremony
argument-hint: ""<description>" [--discuss] [--research] [--full]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---
<objective>
Execute a small task (max 3 tasks) with atomic commits, bypassing the full spec/plan pipeline.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/quick.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the quick workflow from @~/.claude/my-dev/workflows/quick.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init quick`
</process>
