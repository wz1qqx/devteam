# Next Session Execution Plan

This document is the handoff for the next implementation window.
It replaces the earlier cleanup-oriented plan with a new architecture-hardening plan.

The goal is not to add more surface area first.
The goal is to make `devteam` reliable for the real operating model described below.

## User Operating Model

This plan assumes the following workflow is the target behavior:

1. The workspace contains multiple repos.
2. A feature may touch multiple repos.
3. Multiple features may touch the same repo.
4. `feature <-> dev worktree` is effectively many-to-many at the workspace level:
   - one feature may use several repo-specific dev worktrees
   - different features may use different dev worktrees for the same repo
5. The same repo may reuse a shared base worktree across features.
6. Repo remote policy matters:
   - official upstream
   - internal company upstream
   - personal GitHub remote for PRs
7. Build and source-install environments should be reusable when repo/baseline/build inputs are the same.

Current code does not model this cleanly enough yet.
The phases below are ordered to fix that without destabilizing the repo.

## Current Baseline

As of this handoff, the following cleanup work is already done and should be treated as stable:

1. Feature selection is explicit-first:
   - `--feature <name>` wins
   - single-feature auto-select is allowed
   - multi-feature without selection is a hard error
2. Runtime state is feature-scoped:
   - `.dev/features/<feature>/STATE.md`
   - `.dev/features/<feature>/HANDOFF.json`
   - `.dev/features/<feature>/context.md`
3. Shared `active_feature` / shared runtime `STATE.md` assumptions are removed.
4. `loadConfig()` is the normalization boundary.
5. Config loading is fail-fast and normalizes optional blocks.
6. `ship.strategy` is restricted to `k8s`.
7. Stage-result parsing / stage acceptance / pipeline state helpers are already implemented and tested.
8. Current repo tests are green at handoff time.

## Core Problems To Solve

These are the design gaps this plan addresses.
Do not lose sight of them while executing:

1. Multi-repo execution currently depends on fragile prompt-layer path resolution.
2. Dirty dev worktrees are observed but not enforced as a first-class pipeline gate.
3. Task progress / resume state is split across incompatible markdown conventions.
4. Hooks are normalized in config, but runtime execution semantics are not actually unified.
5. Builder first-build behavior is inconsistent with the intended incremental image chain.
6. Build history is feature-local, but reusable build behavior really wants a stronger workspace-level model.
7. Repo model is too flat:
   - single `upstream`
   - raw `dev_worktree` path in feature scope
   - `shared_with` exists in schema text but not in runtime behavior

## Non-Negotiable Invariants

Every phase below must preserve these invariants unless the user explicitly changes direction.

1. Feature-scoped runtime memory remains feature-scoped:
   - no return to shared active-feature state
   - no return to workspace-level runtime `STATE.md` or `HANDOFF.json`
2. `loadConfig()` remains the normalization boundary.
3. Base worktree is read-only reference material.
4. Dev worktree is the only writable source target when `source_restriction == dev_worktree_only`.
5. Dirty worktree behavior must become explicit and testable, not implicit.
6. Prompt markdown is human-readable output, not the long-term machine source of truth for execution state.
7. Hooks/build/review boundaries must be enforced by CLI/runtime helpers, not only by prose instructions.
8. Existing week1-week5 tests must keep passing unless they are intentionally updated as part of a contract change.

## Execution Rules For The Next Window

1. Do not mix multiple major phases into one patch set unless the repo strongly forces it.
2. After every phase:
   - run that phase's targeted tests
   - then run the full regression suite before closing the session
3. Prefer additive migrations first, then switch callers, then delete old paths.
4. If a phase introduces a new machine-readable state file, make it authoritative immediately and demote markdown to a view artifact.
5. If a phase touches config schema, update all three together:
   - loader
   - docs
   - tests
6. Do not start true parallel multi-coder execution in this plan.
   Serial orchestration is acceptable for now.

## Phase 1: Introduce Run Snapshot And Dirty-Worktree Gate

### Objective

Freeze pipeline execution context at start time and stop relying on live config + ad hoc git checks during later stages.

### Why This Phase Is First

Without a frozen run context, every later fix is unstable:

1. Review diffs drift if the worktree changes mid-run.
2. Build/ship/verify may read different repo state than plan/code used.
3. Dirty worktree handling cannot be made reliable.

### Main Files

1. `lib/init.cjs`
2. `lib/pipeline-state.cjs`
3. `lib/devteam.cjs`
4. `skills/orchestrator.md`
5. `agents/coder.md`
6. `agents/reviewer.md`
7. `agents/builder.md`
8. `agents/shipper.md`
9. `agents/verifier.md`
10. `README.md`
11. New helper file(s), likely:
    - `lib/run-state.cjs`
    - `tests/week6-run-state.test.cjs`
    - `tests/week6-dirty-worktree-gate.test.cjs`

### Concrete Tasks

1. Define a new authoritative run artifact:
   - path: `.dev/features/<feature>/RUN.json`
   - created once at pipeline start
   - reset/recreated on explicit restart

2. Define `RUN.json` schema with at least:
   - `version`
   - `run_id`
   - `feature`
   - `created_at`
   - `pipeline_stages`
   - `repos`
   - `dirty_policy`
   - `start_context`

3. For each repo in `RUN.json`, persist:
   - `repo`
   - `base_ref`
   - `base_worktree`
   - `dev_worktree`
   - `start_head`
   - `start_branch`
   - `has_uncommitted`
   - `status_summary`
   - `build_type`

4. Add CLI helper(s) for run state:
   - `run init`
   - `run get`
   - `run reset`
   The exact subcommand names may vary, but the behavior must be centralized in code, not prompt text.

5. Make `/devteam team` initialize `RUN.json` before stage execution.

6. Add dirty-worktree gate at pipeline start:
   - if any targeted dev worktree has uncommitted changes, surface it explicitly
   - orchestrator must ask whether to continue or abort/restart
   - the decision must be visible in `RUN.json` or pipeline state

7. Update reviewer to diff against run start, not only raw `base_ref`.
   Minimum acceptable contract:
   - review scope is frozen by `RUN.json`
   - unrelated later workspace changes are not silently pulled into review

8. Update coder/builder/shipper/verifier prompts to read path/runtime identity from the run snapshot, not by re-deriving it from `plan.md` or ambient workspace state.

### Deliverables

1. Authoritative `RUN.json` runtime model
2. CLI helpers for run lifecycle
3. Explicit dirty-worktree orchestration gate
4. Stage prompts updated to consume frozen run context

### Acceptance Criteria

1. Every pipeline run has exactly one active `RUN.json`.
2. Restarting a pipeline refreshes or replaces the prior run snapshot deliberately.
3. Dirty worktree state is surfaced before code/review/build begin.
4. Reviewer scope is tied to the run snapshot, not ambient repo drift.
5. No stage relies on "first `Worktree:` line in plan.md" to decide where to operate.

### Required Tests

1. New unit/contract tests for `RUN.json` creation and parsing
2. Dirty-worktree gate test
3. Reviewer scope test using a repo mutated after run init
4. Existing week3 pipeline/orchestration tests still pass

## Phase 2: Replace Markdown-Derived Task State With `tasks.json`

### Objective

Create one machine-readable task state model for planning, code execution, pause, and resume.

### Why This Phase Is Second

Current task progress is split across:

1. `plan.md` task status fields
2. coder resume assumptions
3. `pause` checkbox counting
4. `resume` artifact display

That is not a stable persistence contract.

### Main Files

1. `agents/planner.md`
2. `agents/coder.md`
3. `skills/pause.md`
4. `skills/resume.md`
5. `lib/session.cjs`
6. `lib/init.cjs`
7. `lib/devteam.cjs`
8. `README.md`
9. New helper file(s), likely:
   - `lib/task-state.cjs`
   - `tests/week6-task-state.test.cjs`
   - `tests/week6-pause-resume-task-state.test.cjs`

### Concrete Tasks

1. Introduce `.dev/features/<feature>/tasks.json` as authoritative execution state.

2. Define task schema with at least:
   - `id`
   - `title`
   - `repo`
   - `dev_worktree`
   - `files_to_modify`
   - `files_to_read`
   - `depends_on`
   - `wave`
   - `status`
   - `commit`
   - `notes`

3. Standardize task statuses.
   Recommended initial set:
   - `pending`
   - `in_progress`
   - `completed`
   - `blocked`
   - `failed`
   - `skipped`

4. Change planner output behavior:
   - planner still writes `plan.md` for humans
   - planner also writes `tasks.json`
   - `plan.md` becomes a rendered summary view of task state, not the machine source of truth

5. Change coder behavior:
   - read remaining tasks from `tasks.json`
   - update task status through helper code, not markdown editing conventions
   - record commit hashes per task into `tasks.json`

6. Change pause behavior:
   - derive `task_progress`, `completed_tasks`, and `remaining_tasks` from `tasks.json`
   - stop parsing checkbox markers from `plan.md`

7. Change resume behavior:
   - read progress from `tasks.json`
   - use `plan.md` only as a human-readable artifact

8. Ensure handoff consistency:
   - `HANDOFF.json` should reference task IDs or titles from `tasks.json`
   - no alternate task progress calculation path should remain

### Deliverables

1. Authoritative `tasks.json`
2. Planner/coder/pause/resume unified task model
3. Stable task resume semantics

### Acceptance Criteria

1. `plan.md`, `pause`, and `resume` all agree on the same task counts.
2. Coder resume skips only tasks marked `completed` in `tasks.json`.
3. No task progress logic depends on checkbox parsing.
4. A partially completed code phase can be resumed deterministically.

### Required Tests

1. Planner generates `tasks.json`
2. Coder resume respects `tasks.json`
3. Pause/resume derive progress from `tasks.json`
4. Existing session/handoff tests still pass

## Phase 3: Unify Hook Execution Behind A CLI Runner

### Objective

Make hooks an actual runtime feature instead of a partially documented schema.

### Why This Phase Is Third

Hooks are already normalized in config.
What is missing is one execution contract.
Without that, builder/shipper/verifier each interpret hooks differently.

### Main Files

1. `lib/config.cjs`
2. `lib/devteam.cjs`
3. `agents/builder.md`
4. `agents/shipper.md`
5. `agents/verifier.md`
6. `skills/references/schema.md`
7. `README.md`
8. New helper file(s), likely:
   - `lib/hooks-runner.cjs`
   - `tests/week6-hooks-runner.test.cjs`

### Concrete Tasks

1. Add a single CLI execution path for hooks.
   Recommended shape:
   - `hooks run --feature <name> --phase <phase>`

2. Define one normalized runtime hook contract:
   - input source is normalized config
   - arrays remain arrays
   - runner is responsible for iteration order, environment injection, cwd, and error semantics

3. Define hook phase behavior explicitly:
   - `pre_build`: blocking
   - `post_build`: non-blocking or blocking, choose and document
   - `pre_deploy`: blocking
   - `post_deploy`: non-blocking
   - `post_verify`: non-blocking
   - `learned`: filtered by trigger and then executed through the same runner

4. Define environment passed to hooks.
   At minimum include:
   - `DEVTEAM_FEATURE`
   - `DEVTEAM_PHASE`
   - `DEVTEAM_WORKSPACE`
   - `DEVTEAM_RUN_PATH`
   - repo/worktree fields when relevant

5. Remove stage-local hook parsing logic from builder/shipper/verifier prompts.
   They should call the CLI runner only.

6. Update schema/docs to match actual runtime semantics exactly.

### Deliverables

1. `hooks run` CLI helper
2. One hook execution contract shared across all relevant stages
3. Prompt files simplified to orchestration calls instead of ad hoc hook parsing

### Acceptance Criteria

1. Hook arrays are executed in deterministic order.
2. Blocking vs non-blocking behavior is enforced by the runner.
3. `learned` hooks use the same execution path as regular hooks.
4. No stage prompt treats a hook array as a single shell string.

### Required Tests

1. Hooks execute in order
2. Blocking phases fail on hook failure
3. Non-blocking phases warn but continue
4. Existing config normalization tests still pass

## Phase 4: Fix Builder First-Build Semantics And Build Chain Recording

### Objective

Make image parent selection and build recording correct before introducing larger schema changes.

### Why This Phase Is Fourth

Builder currently contradicts its own first-build rule.
That is a correctness issue, not just a cleanup task.

### Main Files

1. `agents/builder.md`
2. `lib/state.cjs`
3. `lib/devteam.cjs`
4. `lib/init.cjs`
5. `skills/references/schema.md`
6. `README.md`
7. New tests, likely:
   - `tests/week6-builder-first-build.test.cjs`
   - `tests/week6-build-record-contract.test.cjs`

### Concrete Tasks

1. Separate three concepts clearly:
   - `fallback_base_image`
   - `parent_image`
   - `new_tag`

2. Fix first-build behavior:
   - if `current_tag` is empty, use `feature.base_image` as the parent/fallback base
   - do not synthesize an invalid `$REGISTRY/$IMAGE:$CURRENT_TAG` parent

3. Fix incremental build behavior:
   - if `current_tag` exists, use the previous built image as `parent_image`

4. Update build record schema and manifest writing so the recorded data distinguishes:
   - parent image actually used
   - fallback base image configured
   - resulting tag

5. Ensure build helpers can also record repo/source identity from `RUN.json`:
   - which repos participated
   - which SHAs were used

6. Keep current feature-local history for now if needed, but make the recorded chain semantically correct.

### Deliverables

1. Correct first-build path
2. Correct incremental parent chain
3. Better build-manifest fidelity

### Acceptance Criteria

1. Empty `current_tag` uses configured `base_image`.
2. Non-empty `current_tag` uses prior built image as parent.
3. Build manifest and build history record the actual parent used.
4. Tests cover first-build and incremental-build paths separately.

### Required Tests

1. First-build contract test
2. Incremental build contract test
3. Existing build/state tests still pass

## Phase 5: Evolve Workspace Schema For Remotes, Baselines, And Dev Slots

### Objective

Upgrade the workspace model so it can represent the real repo/worktree topology cleanly.

### Why This Phase Is Fifth

This is the largest structural change.
It should happen only after run state, task state, hooks, and first-build correctness are stabilized.

### Main Files

1. `skills/references/schema.md`
2. `lib/config.cjs`
3. `lib/init.cjs`
4. `lib/state.cjs`
5. `README.md`
6. New tests, likely:
   - `tests/week7-schema-remotes.test.cjs`
   - `tests/week7-dev-slots.test.cjs`

### Concrete Tasks

1. Replace the single `repos.<name>.upstream` model with explicit remotes.
   Recommended direction:
   - `remotes.official`
   - `remotes.corp`
   - `remotes.personal`

2. Strengthen baseline modeling.
   Move from plain `ref -> path` mapping toward baseline objects with stable identity.
   Recommended fields:
   - `id`
   - `ref`
   - `worktree`
   - `read_only`

3. Introduce explicit dev-slot modeling.
   Recommended direction:
   - workspace-level or repo-level `dev_slots`
   - each slot owns:
     - repo
     - path
     - baseline reference
     - sharing mode
     - optional owner feature list
     - branch metadata

4. Change feature scope to reference dev slots, not raw worktree paths.
   Current direction to phase out:
   - `scope.<repo>.dev_worktree: <dir>`
   Target direction:
   - `scope.<repo>.dev_slot: <slot-id>`

5. Decide whether `shared_with` survives.
   Most likely it should be replaced by explicit slot ownership/sharing metadata, not feature-local hints.

6. Add migration strategy.
   Minimum acceptable migration:
   - loader supports old schema long enough to migrate fixtures
   - migration path is documented
   - tests cover both migration and normalized runtime output if dual support is temporarily added

### Deliverables

1. Explicit remotes model
2. Explicit baseline model
3. Explicit dev-slot model
4. Feature scope references logical execution slots, not only raw paths

### Acceptance Criteria

1. Repo remote policy can represent official/corp/personal clearly.
2. Shared base worktree reuse is first-class in schema.
3. Feature-to-dev-slot mapping is explicit and testable.
4. Runtime no longer relies on undocumented `shared_with` semantics.

### Required Tests

1. Config normalization tests for new repo schema
2. `init` output tests for remotes/baselines/dev slots
3. Migration or compatibility tests if old schema is temporarily supported

## Phase 6: End-To-End Hardening And Documentation Consolidation

### Objective

Make sure the new contracts actually work together and are teachable from docs.

### Why This Phase Exists

Current tests are strong on parser/contract helpers, but weak on realistic workflow scenarios.
After phases 1-5, this must be corrected.

### Main Files

1. `README.md`
2. `skills/orchestrator.md`
3. `skills/pause.md`
4. `skills/resume.md`
5. `agents/*.md` touched by prior phases
6. New integration-style tests, likely:
   - `tests/week7-multi-repo-run.test.cjs`
   - `tests/week7-resume-flow.test.cjs`
   - `tests/week7-hooks-build-run.test.cjs`

### Concrete Tasks

1. Reconcile README architecture text with the new authoritative artifacts:
   - `RUN.json`
   - `tasks.json`
   - `STATE.md`
   - `HANDOFF.json`
   - `context.md`

2. Rewrite orchestrator prompt sections so they describe:
   - run snapshot init
   - dirty-worktree gate
   - task-state ownership
   - hook runner usage
   - build chain semantics

3. Rewrite pause/resume docs so they reference `tasks.json` and run snapshot accurately.

4. Add integration tests covering at least these scenarios:
   - two features touch the same repo but use different dev slots
   - dirty dev worktree is detected before execution
   - partial code stage resumes to the next unfinished task
   - hook arrays execute with correct blocking semantics
   - first build vs incremental build produce correct parent chain records

### Deliverables

1. Docs consistent with runtime behavior
2. Scenario tests for the actual target operating model

### Acceptance Criteria

1. A new session can understand the runtime model from docs without reading source first.
2. Integration tests cover the real personal orchestrator use case, not only isolated helpers.
3. Full regression passes after all phase work is complete.

## Explicitly Deferred Work

Do not start these in this execution plan unless the user explicitly re-prioritizes them.

1. True parallel multi-coder execution
2. Additional ship strategies beyond `k8s`
3. Replacing prompt-first orchestration entirely
4. Large product-surface additions unrelated to reliability hardening

## Recommended Phase Order

Execute in this exact order unless a concrete blocker forces a small reorder:

1. Phase 1: `RUN.json` + dirty-worktree gate
2. Phase 2: `tasks.json` + pause/resume unification
3. Phase 3: hooks runner
4. Phase 4: builder first-build and chain semantics
5. Phase 5: remotes/baselines/dev-slot schema evolution
6. Phase 6: integration hardening and documentation consolidation

## Suggested Commit Strategy

One reasonable commit split is:

1. `refactor: add run snapshot and dirty-worktree gating`
2. `refactor: move task execution state into tasks json`
3. `refactor: centralize hook execution semantics`
4. `fix: correct first-build parent image semantics`
5. `refactor: model repo remotes baselines and dev slots explicitly`
6. `test: add multi-repo resume and build integration coverage`
7. `docs: align orchestrator runtime docs with new execution model`

## Suggested Start Commands

Start the next session with:

```bash
git status --short
sed -n '1,320p' NEXT_SESSION_PLAN.md
node tests/week1-config-validation.test.cjs
node tests/week3-orchestration-kernel.test.cjs
node tests/week4-statusline.test.cjs
```

## Full Regression Command Set

Before ending any substantial phase, run:

```bash
for f in tests/*.test.cjs; do node "$f" || exit 1; done
```
