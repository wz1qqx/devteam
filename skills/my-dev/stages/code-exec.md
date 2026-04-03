# Workflow: code-exec

<purpose>Execute implementation plan tasks using wave-based parallelism. Independent tasks within a wave run as parallel subagents; waves execute sequentially. Each subagent gets fresh context and commits atomically.</purpose>
<core_principle>Parallel within waves, sequential across waves. Every subagent is self-contained — no shared mutable state between agents. Progress is tracked in the plan file and recoverable on resume.</core_principle>

<process>
<step name="INIT" priority="first">
Initialize workflow context and validate prerequisites.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init code-exec)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
PROJECT=$(echo "$INIT" | jq -r '.feature.name')
FEATURE="$1"
```

Gate: `.dev/features/${FEATURE}/plan.md` must exist. If not:
- Abort with: "No plan found. Run `/devflow code $FEATURE --plan` first."
- Auto-redirect to code-plan workflow.
</step>

<step name="PARSE_BEHAVIOR">
Parse behavior layer flags from arguments. These are composable enhancements.

```bash
VERIFY_EACH=$(echo "$ARGUMENTS" | grep -q '\-\-verify' && echo "true" || echo "false")
REVIEW_EACH=$(echo "$ARGUMENTS" | grep -q '\-\-review-each' && echo "true" || echo "false")
PERSISTENT=$(echo "$ARGUMENTS" | grep -q '\-\-persistent' && echo "true" || echo "false")
SEQUENTIAL=$(echo "$ARGUMENTS" | grep -q '\-\-sequential' && echo "true" || echo "false")
```

| Flag | Layer | Effect |
|------|-------|--------|
| `--verify` | Enhancement | After each wave, run smoke test on dev worktree (compile/lint/test) |
| `--review-each` | Enhancement | After each task completes, spawn mini-review before next task |
| `--persistent` | Guarantee | On failure, auto-retry instead of asking user (up to max_task_retries) |
| `--sequential` | Execution | Disable wave parallelism, run all tasks serially |

Display active layers:
```
Behavior: execution=$( [ "$SEQUENTIAL" = "true" ] && echo "sequential" || echo "parallel" )
          enhancement=$( [ "$VERIFY_EACH" = "true" ] && echo "+verify" )$( [ "$REVIEW_EACH" = "true" ] && echo " +review-each" )
          guarantee=$( [ "$PERSISTENT" = "true" ] && echo "persistent" || echo "standard" )
```

**Activate persistent mode Stop hook** (if `PERSISTENT == "true"`):
```bash
PERSISTENT_STATE="$TMPDIR/devflow-persistent-$PPID.json"
if [ "$PERSISTENT" = "true" ]; then
  MAX_ITER=$(echo "$INIT" | jq -r '.tuning.max_task_retries // 10')
  cat > "$PERSISTENT_STATE" << EOF
{"active":true,"iteration":0,"max_iterations":$((MAX_ITER * 3)),"prompt":"Continue executing plan for $FEATURE","started_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
fi
```
This enables the Stop hook (`devflow-persistent.js`) to re-inject continuation if the session tries to end mid-execution.
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
Execute waves sequentially. Within each wave, launch tasks based on behavior flags.

For each wave:

**Execution mode**:
- If `SEQUENTIAL == "true"`: run tasks one at a time within the wave
- Otherwise (default): launch all tasks in parallel

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
2. Commit using the format from tuning config:
   ```bash
   COMMIT_FORMAT=$(echo "$INIT" | jq -r '.tuning.commit_format')
   ```
   Apply $COMMIT_FORMAT, replacing `{feature}` with feature name and `{title}` with task title.
3. Report: what changed, concerns, deviations
</agent_prompt>

**Wait for all tasks in wave to complete.**

**Collect results and verify commits**:
- Success: verify commit exists in dev_worktree (`git log -1`); if missing, create it. Update status to `done`, record commit hash.
- Failure: update status to `failed`, record error.

**Write updated statuses to plan file.** Update `plan_progress` in STATE.md.

**Enhancement: --review-each** (if `REVIEW_EACH == "true"`):
After each task completes successfully, spawn a lightweight my-dev-reviewer with only the task's diff:
```bash
git -C "$DEV_WORKTREE" diff HEAD~1 HEAD
```
If review finds CRITICAL issues, mark task as `needs-fix` and re-queue in next wave.

**Enhancement: --verify** (if `VERIFY_EACH == "true"`):
After all tasks in wave complete, run a verification pass on affected dev worktrees:
```bash
# For each repo touched in this wave:
cd "$DEV_WORKTREE" && make lint 2>/dev/null || echo "no lint"
cd "$DEV_WORKTREE" && make test 2>/dev/null || echo "no test"
```
If verification fails, report which repo/test failed and pause for user decision.

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
2. **Guarantee: --persistent** (if `PERSISTENT == "true"`):
   - Auto-select retry (option a) without asking user
   - Include the error context in the retry prompt for self-correction
   - If retries exhausted ($MAX_RETRIES), fall through to manual options
3. **Standard mode** (no --persistent): Present options:
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
node "$DEVFLOW_BIN" checkpoint \
  --action "code-exec" \
  --summary "Executed $DONE/$TOTAL tasks for $FEATURE"
```

**Deactivate persistent mode** (if it was active):
```bash
PERSISTENT_STATE="$TMPDIR/devflow-persistent-$PPID.json"
[ -f "$PERSISTENT_STATE" ] && rm -f "$PERSISTENT_STATE"
```
</step>
</process>
