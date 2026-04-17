---
name: devteam:learn
description: Research a topic (code, URL, or file) and create/update wiki pages
argument-hint: "<topic|feature|URL|filepath>"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - WebSearch
  - WebFetch
  - Agent
---
<objective>
Research a topic from any source and build/update focused, interlinked wiki pages.
</objective>

<execution_context>
@../../skills/learn.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
INIT=$(node "$DEVTEAM_BIN" init learn)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init learn --feature $SELECTED)`

**Step 2**: Read the skill file and execute it end-to-end:
```bash
SKILL_FILE="${HOME}/.claude/plugins/marketplaces/devteam/skills/learn.md"
[ -f "$SKILL_FILE" ] || SKILL_FILE=$(ls ~/.claude/plugins/cache/devteam/devteam/*/skills/learn.md 2>/dev/null | head -1)
[ -n "$SKILL_FILE" ] || { echo "ERROR: skill file not found" >&2; exit 1; }
```
Read `$SKILL_FILE` for the full process, then follow it step by step.
</process>
