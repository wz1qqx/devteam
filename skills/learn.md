# Skill: learn

<purpose>Research a topic from any source (code, URL, file) and build/update interlinked wiki pages that compound over time. Called manually or by other skills needing domain knowledge.</purpose>
<core_principle>The wiki is a persistent, compounding artifact -- interlinked markdown pages the LLM writes and maintains. Each page covers a single entity or concept (<=300 lines). Knowledge is compiled once and kept current, not re-derived on every query. Human Notes sections are preserved across refreshes.</core_principle>

<process>
<step name="INIT" priority="first">
Load workspace configuration, resolve wiki directory, detect source type.

```bash
TOPIC="$1"
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init learn "$TOPIC")
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
WIKI_DIR=$(echo "$INIT" | jq -r '.wiki_dir // empty')
```

Gate: `TOPIC` must be non-empty. If missing, use active feature from init.

**Wiki directory resolution** (handled by init.cjs):
1. `$VAULT/wiki/` (vault-level unified wiki)
2. `$WORKSPACE/.dev/wiki/` (no-vault fallback)

```bash
mkdir -p "$WIKI_DIR"
```

**Load wiki schema**: If `$WIKI_DIR/_schema.md` exists, read it. Schema is authoritative over hardcoded rules.

**Detect source type** from `$TOPIC`:

| Pattern | SOURCE_TYPE | Example |
|---|---|---|
| Starts with `http://` or `https://` | `url` | `https://arxiv.org/abs/2401.02731` |
| Existing file path (`.md`, `.pdf`, `.txt`, `.html`, `.json`, `.yaml`) | `file` | `/path/to/meeting-notes.md` |
| Everything else | `code` | `vllm-scheduler`, `pd-disaggregation` |

For `code` type: resolve base worktrees and HEAD commits for each repo in feature scope.
For `url` and `file` types: no base worktree resolution needed.
</step>

<step name="CHECK">
Check wiki for existing pages related to this topic.

```bash
EXISTING_PAGES=$(find "$WIKI_DIR" -name "*.md" -not -name "index.md" -not -name "log.md" -type f)
```

Scan `wiki/index.md` (if it exists) to understand existing wiki structure.

**For SOURCE_TYPE=code:**
For each page whose filename or tags match `$TOPIC`:
- Read frontmatter `repo_commits`
- Compare against current base worktree HEAD commits

Determine status:
- **FRESH**: All pages exist and all commits match -- load for context, skip to REPORT
- **STALE**: Pages exist but commits differ -- delta update needed
- **MISS**: No matching pages -- full research needed

**For SOURCE_TYPE=url:**
Check if any page has matching `source_url` in frontmatter:
- Match found with `fetched_date` <7 days -- FRESH
- Match found with `fetched_date` >=7 days -- STALE (re-fetch)
- No match -- MISS

**For SOURCE_TYPE=file:**
Check if any page has matching `source_file` in frontmatter:
- Match found -- STALE (always re-read, files change without version tracking)
- No match -- MISS
</step>

<step name="RESEARCH">
Gather knowledge from the detected source. Read actual content, never rely on summaries.

**SOURCE_TYPE=code** (base worktrees):

*MISS* (full research):
1. Find all relevant files (Glob/Grep for topic keywords)
2. Read core implementation files thoroughly
3. Extract: architecture, data flow, key algorithms, interaction patterns
4. Identify non-derivable insights: WHY decisions were made, non-obvious pitfalls, hidden interactions

*STALE* (delta research):
1. `git diff/log` between old and new commits
2. Read changed files
3. Focus on NEW insights only -- what changed, what contradicts existing pages

**SOURCE_TYPE=url** (web content):
1. Use WebFetch to retrieve page content
2. If GitHub URL -- prefer `gh` CLI for structured data
3. If paper/documentation -- extract: core concepts, findings, methodology
4. If blog/article -- extract: main thesis, technical details, code examples
5. Filter out: navigation, ads, boilerplate
6. Note source URL for citation

**SOURCE_TYPE=file** (local file):
1. Use Read tool to load the file
   - PDF -- use `pages` parameter, read in chunks of 10 pages
   - Markdown/txt -- read full content
   - HTML -- read and extract body content
2. Extract: key decisions, technical details, action items, insights
3. Filter out: meeting logistics, pleasantries, formatting noise

**Key principle**: Research broadly. A single topic often touches multiple related concepts. Follow cross-references in the source material.
</step>

<step name="WRITE_PAGES">
Create or update focused, interlinked wiki pages.

**Decomposition**: Break researched topic into focused entities/concepts. Each page covers ONE thing. Examples:
- "scheduler" topic -> `scheduler-architecture.md`, `kv-cache-management.md`, `batch-scheduling.md`
- URL about a technique -> `technique-overview.md`, `technique-benchmarks.md`
- Meeting notes -> `decision-X.md`, `design-Y.md`

**Page format**:
```yaml
---
date: YYYY-MM-DD
updated: YYYY-MM-DD
project: {group}
# SOURCE_TYPE=code:
repo_commits:
  {repo}: "{current_HEAD_hash}"
# SOURCE_TYPE=url:
source_url: "https://..."
fetched_date: YYYY-MM-DD
# SOURCE_TYPE=file:
source_file: "/path/to/source.md"
tags: [topic1, topic2]
---
```

**Body rules**:
- Free-form markdown, whatever structure best serves the topic
- `[[wikilinks]]` to other wiki pages (both new and existing)
- For code: `file.py:line` citations, code snippets <=10 lines
- For URLs: quote key passages with `>` blockquotes, cite the URL
- For files: cite relevant sections by heading or context
- ASCII diagrams for architecture/data flow
- `## Notes` human protection zone at the end
- Maximum 300 lines per page

**Cross-referencing** (critical for wiki value):
1. After writing new pages, scan for mentions of existing wiki page names -- convert to `[[wikilinks]]`
2. Scan existing pages for mentions of new page topics -- add `[[wikilinks]]` to existing pages
3. This is what makes the wiki compound -- every ingest enriches the link graph

**STALE update**:
- Read existing pages, update changed sections based on delta research
- **Preserve `## Notes` content verbatim**
- Update `repo_commits`/`fetched_date` and `updated` date in frontmatter

**MISS** (new pages):
- Create pages with full content
- Ensure `## Notes` section exists (empty is fine)

Post-write validation per page: <=300 lines, `## Notes` present, frontmatter complete.
</step>

<step name="UPDATE_INDEX">
Update wiki navigation files.

**1. wiki/index.md** -- ensure entries exist for all new/updated pages:
- Format: `- [[page-name]] -- summary (<=120 chars)`
- Group by category (Architecture, Concepts, Interactions, Operations, etc.)
- If category doesn't exist, create it
- Keep index <=300 lines
- If index doesn't exist, create with `# Wiki Index` header

**2. wiki/log.md** -- append ingest entry:
- For code: `- **ingest** {page-list} -- {summary} from {repos}@{commits}`
- For url: `- **ingest** {page-list} -- {summary} from {url}`
- For file: `- **ingest** {page-list} -- {summary} from file:{filename}`
- Add under today's date section (create if needed, newest date at top)
- If log doesn't exist, create with `# Wiki Log` header
</step>

<step name="QUICK_LINT">
Quick health check on pages written/updated in this session only.

For each page touched:
1. **Line count**: if >300 lines, warn: `Warning: {page}.md is {N} lines (limit: 300). Consider splitting.`
2. **Notes section**: if `## Notes` missing, append `\n## Notes\n`
3. **Dead wikilinks**: extract `[[target]]` references, verify each target exists as `$WIKI_DIR/{target}.md`
4. **Reverse cross-refs**: scan other wiki pages for mentions of new page concepts -- add `[[wikilink]]` at first mention if missing

Output:
```
Quick lint (N pages):
  OK page-a.md (187 lines)
  OK page-b.md (142 lines)
  WARN page-c.md (312 lines) -- consider splitting
  Auto-fixed: +2 reverse cross-refs (scheduler.md, kv-connector.md)
```
</step>

<step name="REPORT">
Output result summary.

```
Wiki Ingest: $TOPIC
  Source: code / url / file
  Status: CREATED / UPDATED / FRESH (skipped)
  Pages: page1.md (N lines), page2.md (N lines), ...
  Wiki dir: $WIKI_DIR
  Cross-refs added: X new [[wikilinks]]
  Source details:
    code: <repos with commit hashes>
    url: <fetched URL>
    file: <source file path>
```

Checkpoint (if called manually):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "learn" \
  --summary "Wiki ingest: $TOPIC ($STATUS)"
```
</step>
</process>

<anti_rationalization>

## Anti-Rationalization Table

| Temptation | Reality Check |
|---|---|
| "I already know this codebase" | Knowledge decays. Verify against current code. |
| "One big page is fine" | 300 lines max. Split into focused entities. Big pages rot. |
| "I'll add wikilinks later" | Cross-refs are the value. Link NOW or the wiki stays flat. |
| "The Notes section is empty, skip it" | Notes is a contract with the human. Always include it. |
| "This URL content is too long" | Extract, don't dump. Focus on non-derivable insights. |
| "I'll skip the index update" | Orphan pages are invisible pages. Update index every time. |

## Red Flags

- Wiki page >300 lines without a split plan
- No `## Notes` section on any page
- Dead wikilinks (references to pages that don't exist)
- Index not updated after adding new pages
- STALE pages with old `repo_commits` left unrefreshed
- Human-written Notes overwritten during update

## Verification Checklist

- [ ] Each page <=300 lines
- [ ] Each page has `## Notes` section
- [ ] Frontmatter complete (date, tags, source metadata)
- [ ] Cross-references added (new -> existing and existing -> new)
- [ ] index.md updated with new entries
- [ ] log.md has ingest entry for this session
- [ ] No dead wikilinks

</anti_rationalization>
