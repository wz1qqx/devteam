# Workflow: code-spec

<purpose>Generate or update a feature specification through interactive Q&A, grounded in project context and knowledge base.</purpose>
<core_principle>Understand requirements BEFORE writing code. A spec prevents wasted effort and ensures cross-repo alignment.</core_principle>

<process>
<step name="INIT" priority="first">
Initialize workflow context and load project configuration.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init code-spec)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
PROJECT=$(echo "$INIT" | jq -r '.feature.name')
FEATURE="$1"  # Feature name from arguments
```

Validate: `FEATURE` must be non-empty. If missing, prompt user: "Which feature? Provide a short kebab-case name."

Gate: `.dev.yaml` must exist at `$WORKSPACE`. If not, abort with: "Run `/devflow init` first."
</step>

<step name="LOAD_CONFIG">
Read project configuration and extract repo layout.

```bash
REPOS=$(echo "$INIT" | jq -r ".scope | keys[]")
VAULT=$(echo "$INIT" | jq -r '.vault')
DEVLOG_GROUP=$(echo "$INIT" | jq -r '.devlog.group')
INVARIANTS=$(echo "$INIT" | jq -r '.feature.invariants')
```

For each repo, collect:
- `upstream`, `base_ref`, `dev_worktree`
- Current diff stat: `git -C "$WORKSPACE/<dev_worktree>" diff --stat <base_ref>`
</step>

<step name="LOAD_KNOWLEDGE">
Search the Obsidian vault for knowledge notes matching the feature keyword.

```bash
# Glob for matching knowledge notes
KNOWLEDGE_DIR="$VAULT/$DEVLOG_GROUP/knowledge"
MATCHES=$(ls "$KNOWLEDGE_DIR"/*"$FEATURE"*.md 2>/dev/null || echo "")
```

If matches found:
- Read each note, extract frontmatter `date` field
- Run freshness check: `git log -1 --format=%aI <related_file>` vs note date
- If stale, warn: "[Knowledge Freshness] <note> may be outdated"

If no matches:
- Note: "No knowledge coverage for '$FEATURE'. Consider `/devflow learn $FEATURE` after spec."
</step>

<step name="CHECK_EXISTING">
Check if a spec already exists for this feature.

```bash
FEATURE_DIR="$WORKSPACE/.dev/features/${FEATURE}"
SPEC_PATH="$FEATURE_DIR/spec.md"
```

If spec exists:
- Read it, display current spec summary
- Ask: "Update existing spec or start fresh?"
- If update: load as base context for refinement
- If fresh: archive old spec with timestamp suffix

If not exists:
- Ensure directory: `mkdir -p "$FEATURE_DIR"`
- Proceed to interactive generation
</step>

<step name="INTERACTIVE_QA">
Gather requirements through structured questions. Do NOT skip any question.

**Mandatory Questions** (ask one at a time, wait for response):

1. **Goal**: "What problem does this feature solve? (1-2 sentences)"
2. **Scope**: "Which repos and files are involved?"
   - For each mentioned repo, verify it exists in `.dev.yaml` repos
   - If user is unsure, suggest based on knowledge notes and current diffs
3. **Constraints**: "Any API compatibility requirements? Breaking changes allowed?"
   - Cross-reference with `invariants.build_compat_check`
4. **Verification**: "How do we verify success? (smoke test, benchmark threshold, accuracy check)"
5. **Out of Scope**: "What should this feature explicitly NOT include?"

**Optional Follow-ups** (ask if relevant):
- "Cross-repo dependencies? Which repo changes must land first?"
- "Build mode implications? (Python-only = fast, Rust/C++ = rust/full)"
- "Any known risks or gotchas from previous attempts?"

Collect all answers into structured data for spec generation.
</step>

<step name="GENERATE_SPEC">
Generate the spec document from collected answers.

Use the spec template:

```markdown
# Feature Spec: <FEATURE>

Created: <TODAY_DATE>
Project: <PROJECT>
Status: draft

## Goal
<answer_1>

## Context
<knowledge_notes_summary + why_needed>

## Scope

### Repos & Files
| Repo | Worktree | Files | Change Type |
|------|----------|-------|-------------|
| <repo> | <dev_worktree> | <file_paths> | new / modify / delete |

### Out of Scope
<answer_5>

## Constraints
- API Compatibility: <answer_3>
- Build Mode: <inferred_from_file_types>
- Cross-Repo Dependencies: <if_any>
- Invariants: <active_invariants_from_config>

## Verification Criteria
- [ ] <smoke_criterion>
- [ ] <accuracy_criterion>
- [ ] <performance_criterion>

## Risk Assessment
- <risk>: <mitigation>
```

Present the generated spec to the user for review.
Ask: "Approve this spec? (yes / edit section N / regenerate)"
</step>

<step name="SAVE_SPEC">
Save the approved spec to the feature directory and update STATE.md.

```bash
mkdir -p "$WORKSPACE/.dev/features/${FEATURE}"
# Write spec content to file
cat > "$WORKSPACE/.dev/features/${FEATURE}/spec.md" << 'SPEC_EOF'
<generated_spec_content>
SPEC_EOF
```

State update (@references/shared-patterns.md#state-update): stage=`spec`

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "code-spec" \
  --summary "Spec created for feature: $FEATURE"
```

Output next step:
```
Spec saved: .dev/features/<FEATURE>/spec.md

Next: /devflow code <FEATURE> --plan
```
</step>
</process>
