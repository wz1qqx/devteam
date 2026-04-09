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
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init knowledge)
```

**Step 2**: Execute:
Parse action (search/lint/list). SEARCH: match wiki/index.md, load pages, synthesize. LINT: check over-long, stale, orphans, dead links. LIST: display index.
</process>
