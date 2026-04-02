---
name: devflow:learn
description: Deep-dive learning - analyze feature and generate knowledge doc
argument-hint: "<feature>"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - WebSearch
  - Agent
---
<objective>
Research a feature's codebase and generate dual-layer Obsidian knowledge documents.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/learn.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the learn workflow from @~/.claude/my-dev/workflows/learn.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init learn`
</process>
