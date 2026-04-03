# Workflow: code-plan

<purpose>Generate an ordered implementation plan from a feature spec, with wave-based dependency analysis and cross-repo compatibility verification.</purpose>
<core_principle>Plans must be executable by independent subagents. Each task is self-contained with explicit inputs, outputs, and constraints. Wave ordering ensures correctness across repos.</core_principle>

<process>
<step name="INIT" priority="first">
Initialize workflow context and validate prerequisites.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init code-plan)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
PROJECT=$(echo "$INIT" | jq -r '.feature.name')
FEATURE="$1"
```

Gate: `.dev/features/${FEATURE}/spec.md` must exist. If not:
- Abort with: "No spec found. Run `/devflow code $FEATURE --spec` first."
- Auto-redirect to code-spec workflow.
</step>

<step name="KNOWLEDGE_CHECK">
Auto-check Obsidian knowledge for the feature (@learn.md).

1. Check Obsidian `knowledge/` for notes matching `$FEATURE`
2. FRESH → load into planner context
3. STALE or MISS → run learn workflow, then load

```bash
VAULT=$(echo "$INIT" | jq -r '.vault')
DEVLOG_GROUP=$(echo "$INIT" | jq -r '.devlog.group')
KNOWLEDGE_CONTENT=<content from $VAULT/$DEVLOG_GROUP/knowledge/${FEATURE}.md>
```
</step>

<step name="LOAD_CONTEXT">
Read spec, user decisions, and current repo state.

```bash
SPEC_PATH="$WORKSPACE/.dev/features/${FEATURE}/spec.md"
CONTEXT_PATH="$WORKSPACE/.dev/features/${FEATURE}/context.md"
```

1. Parse spec: Goal, Scope (repos/files/change types), Constraints, Verification Criteria
2. For each repo in scope: read target file state in `dev_worktree`, read base_ref version, collect existing diff
3. Load knowledge note and invariants (`source_restriction`, `build_compat_check`)
</step>

<step name="SPAWN_PLANNER">
Spawn the planner agent to generate the task breakdown.

Spawn agent: my-dev-planner
<agent_prompt>
You are generating an implementation plan for feature "$FEATURE".

## Spec
<full_spec_content>

## User Decisions (from context.md, if available)
<LOCKED decisions — do NOT override. Honor every D-xx ID exactly.>

## Domain Knowledge (from Obsidian)
<knowledge note content>

## Current State
<for each repo: file contents, existing diffs, base_ref versions>

## Constraints
- source_restriction: <value>
- build_compat_check: <value>
- Cross-repo dependencies from spec

## Output Format

Generate markdown with this structure:

```
# Implementation Plan: <FEATURE>
Created: <DATE> | Tasks: <N> | Waves: <W>

## Wave 1: <description>
### Task 1: <title>
- **Status**: pending
- **Repo**: <name> | **Worktree**: <path>
- **Files**: <list>
- **Action**: <detailed description>
- **Depends On**: none
- **Delegation**: subagent|direct

## Cross-Repo Compatibility Check
- [ ] <checks>

## Risk Assessment
- <risk>: <mitigation>
```

Rules:
- Tasks in same wave: NO mutual dependencies, NO shared files
- Cross-repo API: producer wave BEFORE consumer wave
- Each task: max ~200 lines changed, self-contained with explicit context
- "subagent" for implementation, "direct" for simple config changes
</agent_prompt>

Wait for planner result. Store as `DRAFT_PLAN`.
</step>

<step name="CHECK_AND_SAVE">
Verify plan quality, then save.

Spawn agent: my-dev-plan-checker to verify:
1. Completeness (covers all spec files/repos)
2. Wave ordering (cross-repo deps correct)
3. Task granularity (≤200 lines each)
4. Self-containment (no implicit knowledge)
5. Constraint compliance
6. No same-wave file conflicts
7. Missing tasks
8. Verification coverage

If APPROVED: save directly.
If REVISION_NEEDED: feed feedback to planner, re-check once. If still failing, present to user.

Save plan:
```bash
mkdir -p "$WORKSPACE/.dev/features/${FEATURE}"
# Write DRAFT_PLAN to plan.md
```

State update (@references/shared-patterns.md#state-update): stage=`plan`, plan_progress=`0/$TASK_COUNT`

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "code-plan" \
  --summary "Plan created for $FEATURE: $TASK_COUNT tasks in $WAVE_COUNT waves"
```

```
Plan saved: .dev/features/<FEATURE>/plan.md
Tasks: <N> across <W> waves
Next: /devflow code <FEATURE> --exec
```
</step>
</process>
