# Workflow: code-review

<purpose>Automated code review of all changes across repos for a feature. Checks quality, cross-repo compatibility, invariant compliance, and security.</purpose>
<core_principle>Quality gate before build. Catch issues while context is fresh, not after a failed deploy.</core_principle>

<process>
<step name="INIT" priority="first">
Initialize workflow and validate prerequisites.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init code-review)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
PROJECT=$(echo "$INIT" | jq -r '.feature.name')
FEATURE="$1"
```

Gate: At least one task in `.dev/features/${FEATURE}/plan.md` must be `done`.
If no plan exists, check if there are any diffs in dev_worktrees (ad-hoc review mode).
</step>

<step name="COLLECT_DIFFS">
Gather all diffs across repos for this feature.

For each repo in project:
```bash
DIFF=$(git -C "$WORKSPACE/$DEV_WORKTREE" diff "$BASE_REF")
STAT=$(git -C "$WORKSPACE/$DEV_WORKTREE" diff --stat "$BASE_REF")
LOG=$(git -C "$WORKSPACE/$DEV_WORKTREE" log --oneline "$BASE_REF"..HEAD)
```

Aggregate into a review package:
- Total files changed, insertions, deletions per repo
- Full diff content for each repo
- Commit log per repo
</step>

<step name="SPAWN_REVIEWER">
Spawn the reviewer agent with full diff context.

Spawn agent: my-dev-reviewer
Model: resolved via `node "$DEVFLOW_BIN" resolve-model my-dev-reviewer`
Prompt:
<agent_prompt>
You are reviewing code changes for feature "$FEATURE" in project "$PROJECT".

## Spec
<spec_content from .dev/features/$FEATURE/spec.md>

## Changes by Repo
<for each repo: diff stat + full diff + commit log>

## Active Invariants
- source_restriction: $SOURCE_RESTRICTION
- build_compat_check: $BUILD_COMPAT

## Review Checklist

Evaluate each category. For each finding, assign severity: CRITICAL / HIGH / MEDIUM / LOW.

1. **Code Quality**: naming, structure, readability, error handling
2. **Immutability**: no in-place mutation of objects, arrays, or shared state
3. **File Organization**: files < 800 lines, functions < 50 lines, high cohesion
4. **Cross-Repo API Compatibility**: if repo A changed an API that repo B consumes, verify compatibility
5. **Invariant Compliance**:
   - source_restriction: are all file paths within registered dev_worktrees?
   - build_compat_check: are changes backward-compatible with base_ref?
6. **Security**: no hardcoded secrets, input validation, no leaked error details
7. **Error Handling**: all errors handled explicitly, no silent swallowing
8. **Spec Compliance**: do changes match what the spec described?

## Output Format

```markdown
# Code Review: $FEATURE

Date: <today>
Reviewer: automated (my-dev-reviewer)

## Summary
| Repo | Files Changed | Insertions | Deletions |
|------|--------------|------------|-----------|

## Findings

### CRITICAL (must fix before build)
- [ ] <finding with file:line reference>

### HIGH (should fix)
- [ ] <finding>

### MEDIUM (consider)
- [ ] <finding>

### LOW (optional improvement)
- [ ] <finding>

## Cross-Repo Compatibility
- [x/fail] <check>

## Verdict
PASS | PASS_WITH_WARNINGS | FAIL
<reasoning>
```
</agent_prompt>

Wait for reviewer result.
</step>

<step name="AUTO_FIX">
Attempt automatic fixes for CRITICAL findings.

Parse review findings. For each CRITICAL item:

1. Extract: file path, line number, issue description, suggested fix
2. If the fix is deterministic (e.g., remove hardcoded secret, add missing error check):

   Apply the fix directly in the main session (no sub-agent needed for small targeted fixes):
   - Read the file at the specified path and line
   - Apply the minimal fix using Edit tool
   - Commit with message: `fix($FEATURE): <finding_summary>`

3. If fix is non-trivial or ambiguous: skip auto-fix, leave for user

Report auto-fix results:
```
Auto-fixed: N/M CRITICAL findings
Remaining: K findings require manual attention
```
</step>

<step name="SAVE_REVIEW">
Save the review report to the feature directory.

```bash
mkdir -p "$WORKSPACE/.dev/features/${FEATURE}"
cat > "$WORKSPACE/.dev/features/${FEATURE}/review.md" << 'REVIEW_EOF'
<review_content>
REVIEW_EOF
```

Based on verdict:

**PASS**:
```
Review: PASS
All checks passed. Ready for build.

Next: /devflow build
```

**PASS_WITH_WARNINGS**:
```
Review: PASS_WITH_WARNINGS
N warnings found (see .dev/features/$FEATURE/review.md)

Next: /devflow build (or fix warnings first)
```

**FAIL**:
```
Review: FAIL
M critical issues found. Must fix before proceeding.

Critical issues:
  1. <file>:<line> - <issue>
  ...

Next: Fix issues, then /devflow code $FEATURE --review
```

State update (@references/shared-patterns.md#state-update): stage=`review`

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "code-review" \
  --summary "Review $VERDICT for $FEATURE: $CRITICAL_COUNT critical, $HIGH_COUNT high"
```
</step>

<step name="KNOWLEDGE_SINK">
@references/shared-patterns.md#experience-sink

Detection criteria: review findings contain recurring or architecture-level patterns applicable to future development
Target file: `knowledge/<pattern>.md` (knowledge dir, not experience dir)
Context fields: `feature=$FEATURE, date=<TODAY>`

Note: For code-review, the target is `knowledge/` not `experience/` — these are reusable design patterns, not debugging lessons.
</step>
</process>
