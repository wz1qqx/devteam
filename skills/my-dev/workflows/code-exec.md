# Workflow: code-exec

<purpose>Execute implementation plan tasks using wave-based parallelism. Independent tasks within a wave run as parallel subagents; waves execute sequentially. Each subagent gets fresh context and commits atomically.</purpose>
<core_principle>Parallel within waves, sequential across waves. Every subagent is self-contained — no shared mutable state between agents. Progress is tracked in the plan file and recoverable on resume.</core_principle>

<process>
<step name="INIT" priority="first">
Initialize workflow context and validate prerequisites.

```bash
INIT=$(node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init code-exec)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
PROJECT=$(echo "$INIT" | jq -r '.feature.name')
FEATURE="$1"
```

Gate: `.dev/features/${FEATURE}/plan.md` must exist. If not:
- Abort with: "No plan found. Run `/devflow code $FEATURE --plan` first."
- Auto-redirect to code-plan workflow.
</step>

<step name="LOAD_PLAN">
Parse the plan file and determine execution state.

```bash
PLAN_PATH="$WORKSPACE/.dev/features/${FEATURE}/plan.md"
```

State update (@references/shared-patterns.md#state-update): stage=`exec`

Parse plan into structured data:
- Extract all tasks with: number, title, status, repo, worktree, files, action, depends_on, delegation
- Extract wave groupings
- Count: total, pending, in_progress, done, failed

**Resume Detection**:
- If any tasks are `done` or `in_progress`: this is a resume
- Show progress table and reset `failed`/`in_progress` tasks to `pending` for retry
</step>

<step name="GROUP_INTO_WAVES">
Organize tasks into executable waves based on dependency graph.

For each wave (in order):
1. Collect all tasks in this wave that are `pending`
2. Verify all dependencies (tasks in previous waves) are `done`
3. If a dependency is `failed`: mark dependent tasks as `blocked`

Build execution schedule:
```
Wave 1: [Task 1 (subagent), Task 2 (subagent)]  -- parallel
Wave 2: [Task 3 (subagent)]                       -- after wave 1 completes
Wave 3: [Task 4 (direct), Task 5 (subagent)]      -- parallel
```
</step>

<step name="EXECUTE_WAVES">
Execute waves sequentially. Within each wave, launch tasks in parallel.

For each wave:

**Launch tasks**: Update plan status to `in_progress`, then:
- `delegation == "subagent"`: Spawn my-dev-executor agent with `run_in_background=true`
- `delegation == "direct"`: Execute in main session

<agent_prompt>
You are implementing Task $TASK_NUM of feature "$FEATURE".

## Context
- Repo: $REPO_NAME, Worktree: $WORKSPACE/$DEV_WORKTREE, Base: $BASE_REF

## Constraints
- source_restriction: $SOURCE_RESTRICTION
- build_compat_check: $BUILD_COMPAT
- IMMUTABILITY: create new objects, never mutate existing ones
- Files < 800 lines, functions < 50 lines

## Task
$TASK_ACTION_DESCRIPTION

## Files to Modify
$FILE_LIST

## Dependencies Completed
$COMPLETED_DEPENDENCY_SUMMARIES

## Deliverables
1. Implement the changes
2. Commit with message: "feat($FEATURE): $TASK_TITLE"
3. Report: what changed, concerns, deviations
</agent_prompt>

**Wait for all tasks in wave to complete.**

**Collect results and verify commits**:
- Success: verify commit exists in dev_worktree (`git log -1`); if missing, create it. Update status to `done`, record commit hash.
- Failure: update status to `failed`, record error.

**Write updated statuses to plan file.** Update `plan_progress` in STATE.md.

**Display progress** after each wave:
```
Progress: $DONE/$TOTAL tasks ($PERCENT%) | Waves: $WAVES_DONE/$WAVES_TOTAL | Failed: $FAILED_COUNT
```
</step>

<step name="ERROR_RECOVERY">
Handle task failures within a wave.

Read max retries from tuning:
```bash
MAX_RETRIES=$(echo "$INIT" | jq -r '.tuning.max_task_retries')
```

When a task fails:
1. Mark as `failed` in plan, mark dependent tasks as `blocked`
2. Present options:
   - a) Retry task (re-spawn with error context, max $MAX_RETRIES retries)
   - b) Debug: `/devflow debug $FEATURE-task$N`
   - c) Skip and continue (dependent tasks blocked)
   - d) Abort (progress saved, resume with `--exec` later)
</step>

<step name="COMPLETION">
Handle execution completion.

**All tasks done**: Save execution summary to `.dev/features/${FEATURE}/summary.md`, append execution record to feature devlog.

State update: stage=`exec`, plan_progress=`$TOTAL/$TOTAL`

```
Execution complete: $FEATURE
All $TOTAL tasks across $WAVES waves completed successfully.
Next: /devflow code $FEATURE --review
```

**Partial completion** (some failed/skipped):
```
Done: $DONE/$TOTAL | Failed: $FAILED | Skipped: $SKIPPED | Blocked: $BLOCKED
Options:
  /devflow code $FEATURE --exec     # Resume
  /devflow code $FEATURE --review   # Review completed work
  /devflow debug $FEATURE           # Investigate failures
```

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" checkpoint \
  --action "code-exec" \
  --summary "Executed $DONE/$TOTAL tasks for $FEATURE"
```
</step>
</process>
