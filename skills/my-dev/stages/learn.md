# Workflow: learn

<purpose>Research a feature's background knowledge using base worktrees, write/update dual-layer Obsidian knowledge documents. Called automatically by code-plan, or manually via /devflow:learn.</purpose>
<core_principle>Base worktrees are the stable code source for research. Obsidian is the knowledge sink. Two layers: deep/ for human learning, knowledge/ for AI consumption. Deep is the source of truth; knowledge is derived from deep. Staleness is tracked via git commit IDs. Human Notes sections are preserved across refreshes.</core_principle>

<references>
@../references/knowledge-conventions.md
@../references/memory-system.md
</references>

<process>

<step name="INIT" priority="first">
Load workspace configuration and resolve feature context.

```bash
FEATURE="$1"
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init learn "$FEATURE")
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
VAULT=$(echo "$INIT" | jq -r '.vault // empty')
DEVLOG_GROUP=$(echo "$INIT" | jq -r '.devlog.group // empty')
```

Gate: `FEATURE` must be non-empty. If missing, use active feature from init.

**Vault gate**: If `VAULT` is empty or "null", inform user: "Obsidian vault not configured. Set `vault` in .dev.yaml to enable knowledge persistence. Research results will be saved to `.dev/features/<feature>/` only."
- If vault is configured: `KNOWLEDGE_DIR="$VAULT/$DEVLOG_GROUP/knowledge"` and `DEEP_DIR="$VAULT/$DEVLOG_GROUP/deep"`
- If vault is NOT configured: skip Obsidian writes, save research output to `.dev/features/$FEATURE/research.md` instead

Resolve base worktrees and HEAD commits for each repo in feature scope.
</step>

<step name="CHECK_EXISTING">
Check BOTH layers for existing documents.

For deep/ and knowledge/:
- **FRESH**: Both exist, all commits match → skip
- **STALE**: Exists but commits differ → delta update needed
- **MISS**: Does not exist → full research needed

If deep/ exists but knowledge/ doesn't (or vice versa), treat the missing layer as MISS.
</step>

<step name="RESEARCH">
Explore base worktrees to gather knowledge. Must read actual source code, not rely on summaries.

**Scope**: base worktrees ONLY (stable release code).

**MISS** (full research):
1. Find all relevant files (Glob/Grep for feature keywords)
2. Read core implementation files thoroughly
3. Extract: class hierarchy, method signatures with line numbers, data flow, state machines
4. Identify non-derivable insights: WHY decisions were made, non-obvious pitfalls, hidden interactions

**STALE** (delta research):
1. `git diff/log` between old and new commits
2. Read changed files
3. Focus on NEW insights only
</step>

<step name="WRITE_DEEP">
Write or update the deep/ layer article.

**Style selection** (per _conventions.md):
- Architecture topics (systems, data flow, protocols) → **反向金字塔**: 先全景再细节，请求/数据旅程主线
- Optimization topics (algorithms, performance, caching) → **自底向上**: 问题动机→方案，数值例子驱动

**Format requirements**:
- Frontmatter: date, project, freshness, type: deep-dive, style: architecture|optimization
- `> AI 摘要版：[[knowledge/$FEATURE]]` reverse link
- `## 文章结构` outline
- All class/method references with `file.py:line` citations
- Code snippets ≤10 lines showing key logic
- ASCII diagrams for architecture/data flow
- `## Notes` human protection zone at end
- Target length: 300-500 lines

**MISS** → create new article
**STALE** → read existing, update changed sections, **preserve `## Notes` content verbatim**

Post-write: validate length, reverse link exists, Notes section present.
</step>

<step name="WRITE_KNOWLEDGE">
Derive the knowledge/ layer from the deep/ article.

**Distillation rules** (per _conventions.md):
- Extract Key Insight as 2-4 sentence narrative paragraph
- Compress Design Decisions to decision + Why
- Keep Gotchas with severity levels where appropriate
- Add `> 完整教学文章：[[deep/$FEATURE|Deep Dive: 标题]]` link
- Add `## Related` with wikilinks to other knowledge notes
- Add `## Notes` human protection zone
- **Preserve existing `## Notes` content verbatim**
- Target length: ≤200 lines

**No derivable content**: No function signatures, code snippets, file path tables, class hierarchies.

Post-write: validate ≤200 lines, index entry exists, deep link exists.
</step>

<step name="UPDATE_INDEX">
Update navigation files:

1. `KNOWLEDGE-INDEX.md` — ensure entry exists with correct wikilink + description
2. `_moc-vllm.md` — add to appropriate subsystem group if new topic
3. `deep/_index.md` — add to appropriate style category if new deep article
</step>

<step name="REPORT">
Output result summary.

```
Knowledge: $FEATURE
  Status: CREATED / UPDATED / FRESH (skipped)
  Deep:      $DEEP_DIR/$FEATURE.md (N lines)
  Knowledge: $KNOWLEDGE_DIR/$FEATURE.md (N lines)
  Repos researched: <list with commit hashes>
  Base worktrees used: <paths>
```

If called manually: also write checkpoint.
</step>

</process>
