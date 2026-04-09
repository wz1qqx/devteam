---
name: devteam:diff
description: Show worktree changes across repositories
argument-hint: "[repo]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Display a summary of uncommitted and staged changes across all worktrees managed by the project.
</objective>

<context>
diff $ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init diff)
```

**Step 2**: Execute:
For each repo in $INIT, run git -C <dev_worktree> diff --stat <base_ref>. If specific repo given, show full diff. Otherwise show summary table.
</process>
