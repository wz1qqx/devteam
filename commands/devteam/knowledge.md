---
name: devteam:knowledge
description: Wiki operations — search, lint, list
argument-hint: "<search|lint|list> [query]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Manage the wiki knowledge base — search for answers, run health checks, or list pages.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
INIT=$(node "$DEVTEAM_BIN" init knowledge)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init knowledge --feature $SELECTED)`

**Step 2**: Execute:
Parse action (search/lint/list). SEARCH: match wiki/index.md, load pages, synthesize. LINT: check over-long, stale, orphans, dead links. LIST: display index.
</process>
