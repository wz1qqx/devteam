---
name: devflow:discuss
description: Lock implementation decisions before planning — surface gray areas and capture user choices
argument-hint: "<feature>"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - AskUserQuestion
---
<objective>
Surface gray areas in a feature spec, ask the user to decide, and lock those decisions for the planner.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/discuss.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the discuss workflow from @~/.claude/my-dev/workflows/discuss.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init discuss`
</process>
