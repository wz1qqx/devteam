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

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVFLOW_BIN" init diff --feature $SELECTED)`

**Step 2**: Execute:
```bash
# Each repo entry in $INIT.repos has: dev_worktree, base_ref, base_worktree
echo "$INIT" | jq -c '.repos[]' | while read REPO; do
  REPO_NAME=$(echo "$REPO" | jq -r '.repo')
  DEV_WT=$(echo "$REPO" | jq -r '.dev_worktree // empty')
  BASE_REF=$(echo "$REPO" | jq -r '.base_ref // empty')
  [ -z "$DEV_WT" ] && continue
  git -C "$DEV_WT" diff --stat "$BASE_REF"
done
```
If a specific repo name was given in `$ARGUMENTS`, filter to that repo and show full `git diff` instead of `--stat`.
</process>
