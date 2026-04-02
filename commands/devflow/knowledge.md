---
name: devflow:knowledge
description: Knowledge base operations - list, coverage, update, search
argument-hint: "<list|coverage|update|search>"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Manage the Obsidian knowledge base. Requires vault configured in .dev.yaml.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/knowledge-maintain.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the knowledge workflow from @~/.claude/my-dev/workflows/knowledge-maintain.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init knowledge`
</process>
