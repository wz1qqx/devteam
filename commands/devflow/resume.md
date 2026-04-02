---
name: devflow:resume
description: Restore session state and show current status
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Restore worktree state, active tasks, and pending items from .dev.yaml and state files.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/resume.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the resume workflow from @~/.claude/my-dev/workflows/resume.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init resume`
</process>
