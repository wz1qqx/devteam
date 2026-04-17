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
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
INIT=$(node "$DEVTEAM_BIN" init diff)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init diff --feature $SELECTED)`

**Step 2**: Execute:
For each repo in $INIT, run git -C <dev_worktree> diff --stat <base_ref>. If specific repo given, show full diff. Otherwise show summary table.
</process>
