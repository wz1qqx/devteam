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

## Post-Commit Review Addendum

This addendum is based on a follow-up review of commit `a18396c`:

- Commit: `a18396c`
- Message: `refactor: harden runtime state contracts for multi-repo orchestration`

The phase work landed successfully and the full current test suite is green, including week6/week7.
However, the review found several remaining runtime gaps that are important for real multi-feature use.

This section is the immediate continuation plan for the next coding window.
Treat it as higher priority than any new feature work.

### Current Review Status

Verified in review:

1. Full repo test suite passes:
   - week1
   - week2
   - week3
   - week4
   - week5
   - week6
   - week7
2. `RUN.json`, `tasks.json`, hooks runner, build-chain recording, and schema evolution are implemented.
3. Multi-repo and multi-slot coverage exists, but several edge conditions are still not enforced strongly enough.

### Remaining High-Priority Issues

These are the specific gaps that still need modification.

#### Issue A: Missing `--feature` On Multi-Feature Runtime Calls

Problem:

Several prompt-layer CLI calls still rely on implicit feature resolution even though the repo now supports multi-feature workspaces.
This breaks in real multi-feature runs.

Known affected areas:

1. `skills/orchestrator.md`
   - `orchestration resolve-stage`
   - `pipeline complete`
2. `agents/builder.md`
   - `build record`

Root cause:

These commands eventually call helpers that use `requireFeature(...)`.
In a workspace with more than one feature, they fail unless `--feature` is passed explicitly.

Required outcome:

Every runtime CLI call that depends on feature selection must pass `--feature "$FEATURE"` explicitly.

#### Issue B: Invalid Run Identity Still Passes Pipeline Gate

Problem:

`RUN.json` currently records missing dev worktrees as a status summary, but does not block pipeline readiness.
A run with `dev_worktree_missing` can still report `ready_for_pipeline: true`, and `pipeline init` can still succeed.

This is wrong for the intended contract.

Dirty worktree is a user decision branch.
Missing worktree / invalid git identity is a hard execution error.

Required outcome:

Run gating must reject invalid execution identities before plan/code/review/build start.

At minimum, these conditions must block readiness:

1. missing `dev_worktree`
2. `dev_worktree` path exists but is not a git repo
3. `start_head` cannot be resolved

#### Issue C: Hooks Runner Still Reads Live Repo Topology

Problem:

`hooks run` reads `RUN.json` for run path / run id, but repo/worktree topology still comes from live config resolution.
If a feature's dev slot is changed after run init, hooks drift to the new slot instead of staying frozen to the run snapshot.

This violates the run snapshot contract.

Required outcome:

Hook execution must bind to frozen run repos/worktrees whenever `RUN.json` exists.

#### Issue D: `tasks.json` Summary Semantics For `skipped` Are Inconsistent

Problem:

`remaining_tasks` is currently computed as `total - completed`, while `next_task` excludes `skipped`.
This can produce inconsistent resume/status output.

Required outcome:

`remaining_tasks` and `next_task` must use the same executable-work semantics.

Recommended rule:

1. `completed_tasks` = only `completed`
2. `remaining_tasks` = `pending + in_progress + blocked + failed`
3. `skipped` does not count as remaining

## Follow-Up Wave 1: Fix Explicit Feature Propagation

### Objective

Make multi-feature orchestration safe by removing all implicit feature resolution from runtime helper calls.

### Main Targets

1. `skills/orchestrator.md`
2. `agents/builder.md`
3. Any other prompt/skill file invoking a feature-dependent CLI helper without `--feature`

### Concrete Tasks

1. Add `--feature "$FEATURE"` to every `orchestration resolve-stage` call in `skills/orchestrator.md`.
2. Add `--feature "$FEATURE"` to `pipeline complete` in `skills/orchestrator.md`.
3. Add `--feature "$FEATURE"` to `build record` in `agents/builder.md`.
4. Run a repo-wide grep across `skills/` and `agents/` for `node "$DEVTEAM_BIN"` calls and verify any feature-dependent command is explicit.
5. Do NOT loosen `requireFeature(...)` to compensate. The fix belongs in the callers.

### Acceptance Criteria

1. No prompt-layer runtime call relies on implicit feature auto-selection.
2. A two-feature workspace can successfully resolve stage results, record builds, and complete pipeline state when the current feature is passed explicitly.

### Required Tests

Add a new test:

- `tests/week7-multi-feature-cli-contract.test.cjs`

It should cover:

1. `orchestration resolve-stage --feature feat-a` succeeds in a two-feature workspace
2. the same command without `--feature` fails clearly
3. `build record --feature feat-a` only updates `feat-a`
4. `pipeline complete --feature feat-a` only updates `feat-a`

## Follow-Up Wave 2: Harden Run Identity Gate

### Objective

Treat run identity validity as a first-class gate, separate from dirty-worktree policy.

### Main Targets

1. `lib/run-state.cjs`
2. `lib/pipeline-state.cjs`
3. `skills/orchestrator.md`
4. `README.md` if runtime semantics are documented there

### Concrete Tasks

1. Extend repo snapshot validation in `lib/run-state.cjs`.
2. Add explicit invalid-identity signaling, either:
   - repo-level `ready` + `errors[]`
   - or run-level `has_invalid_repos` + `repo_identity_errors`
3. Update `evaluateRunGate()` so invalid repo identity blocks readiness.
4. Update `pipeline-state.ensureRunGate()` so invalid identity aborts `pipeline init`.
5. Keep dirty-worktree behavior separate:
   - dirty => user decision
   - invalid identity => hard fail

### Acceptance Criteria

1. Missing dev worktree cannot produce `ready_for_pipeline: true`
2. `pipeline init` fails when run identity is invalid
3. Dirty-worktree behavior from existing tests remains unchanged

### Required Tests

Add:

- `tests/week7-run-identity-gate.test.cjs`

It should cover:

1. missing dev worktree
2. non-git dev worktree
3. missing `start_head`
4. valid clean worktree
5. dirty-but-valid worktree still using the decision gate

## Follow-Up Wave 3: Freeze Hooks To `RUN.json`

### Objective

Make hook execution obey the same frozen runtime topology as code/review/build.

### Main Targets

1. `lib/hooks-runner.cjs`
2. `lib/run-state.cjs`
3. `lib/init.cjs`
4. `README.md` or schema docs if runtime behavior needs wording updates

### Concrete Tasks

1. Introduce a helper path in `hooks-runner.cjs` to resolve repos from `RUN.json` first.
2. Merge frozen run repo identity with config metadata only for non-identity fields:
   - remotes
   - dev_slot
   - baseline_id
   - sharing_mode
3. Ensure all hook env vars that expose repo/worktree identity come from frozen run repos whenever a run exists.
4. Decide and document behavior when `RUN.json` is absent.
   Recommended direction:
   - for pipeline-stage usage, prefer fail-fast
   - only allow live-config fallback if intentionally designed and documented

### Acceptance Criteria

1. Hook runner no longer drifts if feature config changes after run init
2. Hook env worktree variables match the run snapshot
3. Multi-repo env propagation remains correct

### Required Tests

Add:

- `tests/week7-hooks-frozen-run-contract.test.cjs`

It should:

1. create a run using `slot-a`
2. mutate feature config to point to `slot-b`
3. run `hooks run`
4. assert hook output/env still points to `slot-a`

## Follow-Up Wave 4: Align Task Summary Semantics

### Objective

Make pause/resume/status summaries consistent for skipped work.

### Main Targets

1. `lib/task-state.cjs`
2. `skills/pause.md`
3. `skills/resume.md`
4. any tests asserting task summary shape

### Concrete Tasks

1. Update `summarizeTaskState()` to make `remaining_tasks` reflect executable work only.
2. Keep `by_status` unchanged.
3. Ensure `next_task` and `remaining_tasks` use the same exclusion logic for `skipped`.
4. Update pause/resume docs if they describe remaining work.

### Acceptance Criteria

1. `remaining_tasks == 0` when only skipped work remains
2. `next_task == null` and `remaining_tasks == 0` are consistent
3. Resume output is no longer misleading when tasks are skipped

### Required Tests

Add:

- `tests/week7-task-summary-semantics.test.cjs`

## Recommended Execution Order For This Addendum

Execute in this order:

1. Wave 1: explicit `--feature` propagation
2. Wave 2: run identity gate
3. Wave 3: frozen hooks contract
4. Wave 4: task summary semantics

Do not reorder Wave 2 and Wave 3 unless there is a concrete implementation dependency.

## Suggested Commit Split For This Addendum

1. `fix: pass explicit feature through multi-feature runtime helpers`
2. `fix: block pipeline start on invalid run identities`
3. `fix: freeze hook execution to run snapshot repos`
4. `fix: align skipped-task summary semantics`
5. `test: add multi-feature and frozen-run regression coverage`

## Validation Commands For This Addendum

Run these targeted tests while implementing:

```bash
node tests/week6-run-state.test.cjs
node tests/week6-dirty-worktree-gate.test.cjs
node tests/week6-hooks-runner.test.cjs
node tests/week6-pause-resume-task-state.test.cjs
node tests/week7-multi-repo-run.test.cjs
node tests/week7-resume-flow.test.cjs
node tests/week7-hooks-build-run.test.cjs
node tests/week7-schema-remotes.test.cjs
```

Then run full regression:

```bash
for f in tests/*.test.cjs; do node "$f" || exit 1; done
```

## Execution-Boundary Hardening Addendum (post week8)

This addendum follows commits `dab8c1e`, `df1b7d8`, and `f881f09` which landed:

- Slot conflict gate at `pipeline init` (with `--allow-slot-conflict` and `sharing_mode: shared` exemption)
- `run check-path` for machine-enforceable `source_restriction: dev_worktree_only`
- Structured `source_refs` in `build record` (auto-read from RUN, `--run-path` override)
- `shared_with` removal from config normalization
- week8 tests: `slot-conflict-gate`, `run-path-validation`, `build-source-provenance`

All 37 tests (week1–week8) are green at handoff time.

### Current Baseline (post week8)

The execution boundary layer is now closed:

| Boundary | CLI Enforcement | Tested |
|---|---|---|
| Frozen run identity | `run init/get/reset` | week6 |
| Dirty worktree gate | `run init` dirty_policy | week6 |
| Invalid identity gate | `pipeline init` ensureRunGate | week7 |
| Slot conflict gate | `pipeline init` checkSlotConflicts | week8 |
| Source restriction | `run check-path` | week8 |
| Hook frozen scope | `hooks run` resolveHookRepos | week7 |
| Build source provenance | `build record` source_refs | week8 |
| Explicit feature routing | all runtime CLI calls | week7 |

### What Is Still Missing

1. **Orchestrator prompt does not describe week8 gates.** `orchestrator.md` INIT step only handles
   `requires_dirty_decision`. It has no branches for `requires_execution_identity_fix` or slot
   conflict errors from `pipeline init`.

2. **No end-to-end pipeline chain test.** All 37 tests are single-step isolations. No test walks
   `run init → pipeline init → orchestration resolve-stage → pipeline complete` as a linked chain.
   A field-name regression could break the full flow while all unit tests pass.

3. **pause/resume uncommitted-file scan references `$INIT.repos` instead of RUN.json repos.**
   `lib/init.cjs` already prioritizes RUN.json for repo construction, so the runtime likely works
   correctly. But `pause.md` L38 and `resume.md` L153-159 describe reading from `$INIT.repos`
   without clarifying that these are already RUN-frozen. A regression test is needed to lock this.

### Phase D: Sync Orchestrator And README With Week8 Gates

#### Objective

Make the orchestrator prompt and README accurately describe the execution boundaries that now exist in code.

#### Concrete Tasks

1. In `skills/orchestrator.md` INIT step, after the dirty-worktree gate block (L94-107),
   add two new gate branches:

   - If `RUN_INIT.requires_execution_identity_fix == true`:
     Surface `RUN_INIT.invalid_execution_repos` to user. Hard stop.
     No AskUserQuestion — this is not a user decision, it is an environment error.

   - If `pipeline init` fails with slot conflict error:
     Surface the conflicting feature name and dev worktree.
     AskUserQuestion: retry with `--allow-slot-conflict`, wait for other pipeline, or cancel.

2. In `skills/orchestrator.md` INIT step, add an "Execution identity rule" note after the
   existing "Execution identity rule" on L110-111, referencing `run check-path` as the
   mechanism coder uses for path validation.

3. In `README.md`, add a brief "Execution Boundaries" subsection to the Architecture section,
   listing the 8 CLI-enforced boundaries from the table above.

4. Update `tests/week3-stage-result-contract.test.cjs` orchestrator assertions to verify:
   - `orchestrator.md` contains `requires_execution_identity_fix`
   - `orchestrator.md` contains `slot conflict` or `allow-slot-conflict`
   - `orchestrator.md` contains `run check-path` or `check-path`

#### Acceptance Criteria

1. A new session reading `orchestrator.md` knows what to do when execution identity is invalid.
2. A new session reading `orchestrator.md` knows what to do when a slot conflict is detected.
3. Automated assertions prevent the orchestrator prompt from silently losing these gate descriptions.

### Phase E: End-To-End Pipeline Chain Integration Tests

#### Objective

Verify that the CLI commands work as a linked chain, not just in isolation.

#### Concrete Tasks

New file: `tests/week9-pipeline-e2e.test.cjs`

Cover at minimum these 6 scenarios:

1. **Happy path lifecycle**:
   `run init → pipeline init → pipeline complete`
   Assert: STATE.md `feature_stage == completed`, RUN.json still exists.

2. **Dirty gate → user decision → continue**:
   `run init (dirty) → run init --restart --dirty-decision continue → pipeline init`
   Assert: `dirty_policy.decision == continue`, pipeline init succeeds.

3. **Slot conflict → rejection → override**:
   feat-a `run init + pipeline init` → feat-b `run init → pipeline init` (fails with slot conflict)
   → feat-b `pipeline init --allow-slot-conflict` (succeeds)

4. **Build record consumes run provenance**:
   `run init → build record`
   Assert: `source_refs[0].repo` matches RUN repo, `run_id` matches.

5. **Completed pipeline does not block subsequent feature on same slot**:
   feat-a `run init + pipeline init + pipeline complete` → feat-b `run init + pipeline init`
   Assert: feat-b pipeline init succeeds (feat-a is completed, not active).

6. **resolve-stage end-to-end chain**:
   `run init → pipeline init → orchestration resolve-stage (synthetic PASS STAGE_RESULT via stdin) → pipeline complete`
   Assert: resolve-stage returns `decision == accept` with correct feature and stage.
   Assert: pipeline complete succeeds after resolve-stage.
   This scenario validates the orchestration interface contract in a linked context, not just parse/decide in isolation.

#### Acceptance Criteria

1. All 6 scenarios pass as a single test file.
2. At least one scenario (scenario 6) exercises the full `run → pipeline → resolve-stage → complete` chain.
3. No test depends on real git repos for scenarios that only need pipeline/state mechanics.
   (Scenarios 1-5 can use non-git workspaces. Scenario 4 needs a git repo for `start_head`.)

### Phase F: Freeze Pause/Resume Repo Scan To RUN Identity

#### Objective

Verify and lock the invariant that pause/resume uncommitted-file scanning uses RUN-frozen repos.

#### Approach

Test first, fix only if needed.

`lib/init.cjs` already reads `RUN.json` via `readRunState` + `reposMapFromRun` + `attachRunReposMetadata`
for team workflows. If the same path is active for `pause`/`resume` workflows, the runtime is already
correct and only documentation alignment is needed.

#### Concrete Tasks

1. New file: `tests/week9-pause-resume-frozen-repos.test.cjs`
   - Create workspace with RUN.json pointing to slot-a dev worktree
   - Mutate feature config to point to slot-b after run init
   - Call `init pause` (or `init resume`) via CLI
   - Assert output `repos` still reference slot-a (from RUN), not slot-b (from live config)
   - If assertion fails: fix `lib/init.cjs` so pause/resume workflows use RUN repos
   - If assertion passes: update `skills/pause.md` and `skills/resume.md` to clarify that
     `$INIT.repos` is already RUN-frozen, not live-config-derived

2. If docs-only change needed:
   - `pause.md` L38: change comment to clarify repos come from RUN snapshot
   - `resume.md` L153-159: same clarification

#### Acceptance Criteria

1. Test locks the invariant: pause/resume repo scan matches RUN.json identity.
2. Prompt text does not mislead a new session into thinking repos come from live config.

### Execution Order

```
Phase D → Phase E → Phase F
```

D must precede E because E's scenario 6 validates orchestration contract text that D updates.
F is independent but placed last because its blast radius is smallest.

### Suggested Commit Split

```
docs: sync orchestrator and README with week8 execution boundaries     # Phase D
test: add end-to-end pipeline chain integration tests                  # Phase E
test/fix: freeze pause/resume repo scan to RUN identity                # Phase F
```

### Validation Commands

```bash
# Phase D
node tests/week3-stage-result-contract.test.cjs

# Phase E
node tests/week9-pipeline-e2e.test.cjs

# Phase F
node tests/week9-pause-resume-frozen-repos.test.cjs

# Full regression
for f in tests/*.test.cjs; do node "$f" || exit 1; done
```

### Non-Negotiable Invariants (carried forward)

All invariants from the original plan remain in force. Additionally:

9. Slot conflict enforcement has exactly two exemption paths: `--allow-slot-conflict` flag or
   `sharing_mode: shared` with both features in `owner_features`. No third implicit path.
10. `run check-path` uses `realpathSync` for symlink-safe path normalization. No prefix-only matching.
11. `source_refs` in build record are structured objects (`{repo, start_head, start_branch, dev_worktree}`),
    not flattened strings. Legacy string format is accepted on read via `normalizeSourceRefList`.

### Explicitly Deferred Work (carried forward + additions)

1. True parallel multi-coder execution
2. Additional ship strategies beyond `k8s`
3. Replacing prompt-first orchestration entirely
4. Large product-surface additions unrelated to reliability hardening
5. Adding `run check-path` enforcement to reviewer/builder/shipper/verifier (low ROI — they don't write source files)
6. Changing `collectActiveRuns` to include dirty-pending runs (current semantics are correct — dirty-pending has not started pipeline, does not occupy slot)
7. ~~Workspace-level build cache / reuse model (original core problem #6)~~ → Scheduled as Phase K below.

## Phase K: Implement Build Reuse Index (original core problem #6)

### Objective

Address the last remaining original core problem with a workspace-level index that allows
deterministic reuse of previously built images when inputs are equivalent.

This eliminates redundant Docker builds when multiple features share the same repo at the
same SHA with the same build mode and parent chain.

### Design Decisions (confirmed)

1. **Reuse key**: `sha256(sorted(repos[].repo + repos[].start_head) + build_mode + parent_image)`.
   Does NOT include `dev_worktree`, `cluster`, or `build_variant`.
   Rationale: same code + same parent + same mode = same image. Paths and deploy targets are irrelevant.

2. **Image verification**: default `docker manifest inspect` on cache hit.
   Registry images may be lost to server restarts. Trust-but-verify is the only safe default.
   No `--skip-verify` flag in v1; can be added later if latency is a real problem.

3. **Git visibility**: `.dev/` should be git-tracked (enables build history traceability).
   `build-index.json` is included in tracked state alongside `build-manifest.md`.

4. **Reuse behavior**: default automatic. When index hits and image is verified, build is skipped
   and a reuse marker is recorded. No opt-in flag needed. `--no-reuse` flag to force rebuild.

### Index Schema

Path: `.dev/build-index.json` (workspace-scoped, git-tracked)

```json
{
  "version": "1.0",
  "updated_at": "<ISO-8601>",
  "entries": [
    {
      "reuse_key": "<sha256>",
      "inputs": {
        "source_refs": [
          { "repo": "repo-a", "start_head": "abc123" }
        ],
        "build_mode": "full",
        "parent_image": "registry.example.com/base:v3"
      },
      "result": {
        "resulting_image": "registry.example.com/feat-a-image:v12",
        "resulting_tag": "v12",
        "run_id": "uuid",
        "feature": "feat-a",
        "recorded_at": "2026-04-16"
      }
    }
  ]
}
```

### Implementation Plan

#### Step 1: `lib/build-index.cjs` — Index CRUD + hash

New file. Functions:

- `computeReuseKey(sourceRefs, buildMode, parentImage)` → sha256 hex string
  - sourceRefs is `[{repo, start_head}]` sorted by repo name
  - null/missing fields normalized to empty string before hashing
- `readBuildIndex(root)` → parsed index object (or empty default if missing/corrupt)
- `writeBuildIndex(root, index)` → write `.dev/build-index.json`
- `lookupReuse(root, reuseKey)` → matching entry or null
- `recordReuseEntry(root, reuseKey, inputs, result)` → append/update entry, write index

#### Step 2: `lib/devteam.cjs` build record path — check before build

In the `build` case of `devteam.cjs`:

1. After computing `sourceRefs`, `parentImage`, and build mode, call `computeReuseKey`.
2. Call `lookupReuse`. If hit:
   - Run `docker manifest inspect <resulting_image>` via `execFileSync` (timeout 15s).
   - If image exists: skip build, set `entry.note = "reused from <original_feature>@<original_tag>"`,
     set `entry.reused = true`, record to build_history + manifest as usual, output includes `reused: true`.
   - If image gone: treat as miss, fall through to normal build.
3. If miss or `--no-reuse` flag: normal build path.
4. After successful `build record` (miss path): call `recordReuseEntry` to write/update index.

#### Step 3: `agents/builder.md` — Document reuse behavior

Add to builder constraints:
- Build may be skipped automatically if workspace build index has a verified cache hit.
- Builder should check `build record` output for `reused: true` and report accordingly in STAGE_RESULT.
- `--no-reuse` forces fresh build regardless of index.

#### Step 4: Tests

New file: `tests/week11-build-reuse-index.test.cjs`

Scenarios:

1. **Miss → build → index populated**: first build creates index entry with correct reuse_key.
2. **Hit → reuse**: second `build record` with same inputs returns `reused: true`, tag matches previous.
3. **Hit but image gone → fallback to build**: mock/simulate image unavailability (corrupt entry with nonexistent image).
4. **Different SHA → miss**: change `start_head` in RUN, verify no reuse.
5. **Different mode → miss**: same SHA but different `build_mode`, verify separate entries.
6. **`--no-reuse` forces build**: even with valid index hit, fresh build is performed.
7. **Cross-feature reuse**: feat-a builds, feat-b with same repo@SHA gets reuse.
8. **Corrupt index → graceful degradation**: malformed JSON in build-index.json does not crash, falls through to build.

#### Step 5: Clean up DevflowError alias

In the same commit batch:
- Remove `DevflowError` from `core.cjs` exports
- Update `week1-core.test.cjs` to assert alias no longer exists

### Acceptance Criteria

1. Two features with identical repo SHAs and build mode produce only one Docker build.
2. Registry image loss is detected and triggers rebuild automatically.
3. Corrupt or missing index never crashes the pipeline.
4. `--no-reuse` provides explicit override.
5. Feature-local `build_history` still records every build/reuse for audit.
6. `.dev/build-index.json` is git-trackable.
7. `DevflowError` alias is removed from exports.

### Suggested Commit Split

```
feat: implement workspace-level build reuse index        # Steps 1-4
refactor: remove DevflowError backward compat alias      # Step 5
```

### Validation Commands

```bash
node tests/week11-build-reuse-index.test.cjs
node tests/week1-core.test.cjs
for f in tests/*.test.cjs; do node "$f" || exit 1; done
```

### Non-Negotiable Invariants (carried forward)

All prior invariants (1-11) remain in force. Additionally:

12. Build reuse is a read-only optimization; it never bypasses run identity, slot, or path gates.
13. Reuse key does NOT include path or cluster; only `repo + start_head + build_mode + parent_image`.
14. Missing or corrupt build-index.json degrades to normal build, never crashes.

## Post-Phase-K Addendum: dev_worktree Removal And bare_metal Ship Strategy

This addendum covers two changes made after Phase K completed.

### Change 1: scope.dev_worktree Hard Removal

**Context**: Phase H introduced deprecation warnings for `scope.<repo>.dev_worktree`. All three real
workspaces (vllm-workspace, llmd-vllm-workspace, dynamo-vllm-workspace) were migrated to `dev_slot`.

**What was done**:

1. Migrated all three real workspaces to `dev_slot`:
   - vllm-workspace: 1 shared slot (pd-opt), 2 features
   - llmd-vllm-workspace: 7 slots across 4 repos, 3 features
   - dynamo-vllm-workspace: 6 slots across 3 repos, 4 features with scope + 2 scopeless;
     3 slots with `sharing_mode: shared` + `owner_features` (replacing old `shared_with`)

2. Migrated all 16 test fixtures from `dev_worktree` to `dev_slot` (workspace.yaml gets `dev_slots`
   definition, feature config switches to `dev_slot: <id>`)

3. Hardened `lib/config.cjs`:
   - `warnDeprecationOnce` replaced with `error()` for `dev_worktree` without `dev_slot`
   - `dev_worktree` stripped from normalized scope output (destructured away alongside `shared_with`)
   - `getFeatureRepos` dev worktree fallback path removed (only slot-derived worktree path remains)
   - `warnDeprecationOnce` function and `DEPRECATION_WARNINGS` Set removed as dead code

4. `tests/week10-dev-worktree-deprecation.test.cjs` updated: asserts error (not warning)

5. `skills/references/schema.md` updated: "dev_worktree 已移除" replaces "仍兼容"

**Note**: `dev_worktree` in `tasks.json` task objects is a different field (task schema, not scope)
and remains unchanged.

### Change 2: bare_metal Ship Strategy

**Context**: Original plan deferred additional ship strategies beyond k8s. The bare_metal strategy
was prioritized because it enables rapid source-deploy verification and A/B comparison experiments
without Docker image builds, which is critical for dynamo + tensorrt-llm development workflows.

**Design decisions** (confirmed with user):
- Deploy method: rsync + SSH (reuses existing `run-dynamo-pd` skill's sync.sh / start.sh)
- Environment: preset (user manages venv/deps via existing skill)
- Multi-node: single node first
- Lifecycle: deploy A → bench → deploy B → bench → compare (A/B workflow deferred to Phase 2)
- Build mode: user-explicit via `build_mode` field (skip / sync_only / source_install / docker)

**What was done**:

1. `lib/config.cjs`:
   - `SUPPORTED_SHIP_STRATEGIES` extended: `['k8s', 'bare_metal']`
   - `normalizeShipMetal()` function: normalizes `ship.metal.*` fields
   - `normalizeFeatureConfig` attaches `ship.strategy` and `ship.metal` to normalized output

2. `lib/init.cjs`:
   - `shipConfig` extracted from feature config
   - Added to `team`, `team-build`, `team-deploy`, `team-verify` workflow outputs

3. `agents/shipper.md`:
   - Context loads `SHIP_STRATEGY` and `METAL_*` variables
   - `STRATEGY_BRANCH` step: bare_metal skips k8s workflow
   - `BARE_METAL_DEPLOY` step: stop → sync → start → health poll → first inference → log check

4. `agents/verifier.md`:
   - Context loads `SHIP_STRATEGY`, `METAL_HOST`, `METAL_SERVICE_URL`, `METAL_LOG_*`
   - bare_metal overrides `SSH_HOST` and `SVC_URL`
   - Log check branches: SSH grep (bare_metal) vs kubectl logs (k8s)

5. `skills/orchestrator.md`:
   - INIT loads `SHIP_STRATEGY`
   - RUN_BUILD: bare metal build mode guard (skip/sync_only/source_install/docker)
   - RUN_SHIP: strategy-aware behavior description

6. `skills/references/schema.md`: full `ship.metal.*` field documentation

7. Tests:
   - `tests/week12-bare-metal-ship-strategy.test.cjs`: 8 scenarios
   - `tests/week3-stage-result-contract.test.cjs`: orchestrator bare_metal/SHIP_STRATEGY assertions
   - `tests/week3-ship-strategy.test.cjs`: error message assertion updated for new strategy set

**ship.metal schema**:

```yaml
ship:
  strategy: bare_metal
  metal:
    host: <ssh-alias>
    venv: /opt/pd-venv
    code_dir: /opt/dynamo
    profile: <rapid-test-profile>
    config: <start.sh-config>
    sync_script: .dev/rapid-test/sync.sh
    start_script: .dev/rapid-test/start.sh
    setup_script: .dev/rapid-test/setup.sh    # optional
    service_url: <host>:8000
    log_paths:
      decode: /tmp/dynamo-decode.log
      prefill: /tmp/dynamo-prefill.log
```

### Deferred: A/B Comparison Flow

The core value of bare_metal is running two versions on the same machine for fair comparison.
This is deferred as Phase 2 because it requires:
- Managing baseline code sync (which worktree/branch to deploy as baseline)
- Orchestrator flow: deploy A → bench → deploy B → bench → generate comparison report
- `--compare <baseline>` CLI argument parsing in orchestrator

### Non-Negotiable Invariants (carried forward)

All prior invariants (1-14) remain in force. Additionally:

15. `scope.dev_worktree` is a hard error. All feature scopes must use `dev_slot`.
16. `ship.strategy` accepts only `k8s` or `bare_metal`. Invalid strategies fail fast at config load.
17. bare_metal shipper reuses user-provided scripts (sync.sh/start.sh). devteam does not own
    remote environment management.

### Explicitly Deferred Work (updated)

1. True parallel multi-coder execution
2. ~~Additional ship strategies beyond `k8s`~~ → bare_metal landed; further strategies (docker-compose, cloud run) still deferred
3. Replacing prompt-first orchestration entirely
4. A/B comparison flow for bare_metal (Phase 2)
5. Multi-node bare_metal orchestration
