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
@../../skills/my-dev/stages/learn.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the learn stage from @../../skills/my-dev/stages/learn.md end-to-end.
Load project config via: `node "$DEVFLOW_BIN" init learn`
</process>
