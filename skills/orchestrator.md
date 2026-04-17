# Skill: orchestrator (TEAM)

<purpose>
Automated multi-agent pipeline orchestration. One command starts a configurable lifecycle
with optimization feedback loops. Stages are selectable via --stages.
Uses Claude Code native TeamCreate + Agent + TaskCreate + SendMessage mechanisms.
</purpose>

<core_principle>
The orchestrator is a coordinator, not an implementer. It creates the team, spawns agents
sequentially based on dependency gates, handles feedback loops (reviewer FAIL → coder fix,
verifier FAIL → vllm-opter → planner re-plan), and cleans up when done.

Agents are spawned using their native subagent_type (e.g., "devteam:coder") so that tool
restrictions and permissionMode from their frontmatter are enforced by Claude Code.
The orchestrator owns all user interaction (AskUserQuestion) since plugin agents cannot use it.
The orchestrator also owns all checkpoint and pipeline-state writes. Agents report outcomes;
the orchestrator decides whether a stage is accepted.

Authoritative runtime artifacts:
- `RUN.json`: frozen execution identity (repos/worktrees/start SHAs/dirty policy/stages)
- `tasks.json`: authoritative machine task state for plan/code/pause/resume
- `STATE.md`: checkpoint and stage progress view
- `HANDOFF.json`: pause/resume transfer payload
- `context.md`: feature-scoped decisions and blockers
</core_principle>

<process>

<step name="INIT" priority="first">
Initialize workflow context and parse arguments.

```bash
DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
```

Parse from $ARGUMENTS:
- **FEATURE**: first positional arg (optional — will prompt if not provided)
- **--stages X,Y,Z**: comma-separated stages to run (default: all)
  Valid stages: `spec,plan,code,review,build,ship,verify`
- **--max-loops N**: max optimization iterations (default from tuning config)
- **--skip-spec**: shorthand for removing `spec` from stages
- **--build-mode MODE**: optional build override for this run
  Valid modes: `skip`, `sync_only`, `source_install`, `docker`

```bash
FEATURE="$1"
if [ -n "$FEATURE" ]; then
  INIT=$(node "$DEVTEAM_BIN" init team --feature "$FEATURE")
else
  INIT=$(node "$DEVTEAM_BIN" init team)
fi
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
SHIP_STRATEGY=$(echo "$INIT" | jq -r '.ship.strategy // "k8s"')
```

**Feature selection**: If `$INIT` has `feature: null` and `available_features` list, use AskUserQuestion
to let the user pick a feature from the list. Then re-run `init team --feature $SELECTED`.

**Stage selection**:
```
ALL_STAGES = [spec, plan, code, review, build, ship, verify]

if --stages provided:
  STAGES = parse comma-separated list, validate each against ALL_STAGES
elif --skip-spec:
  STAGES = ALL_STAGES minus "spec"
else:
  STAGES = ALL_STAGES
```
Also build `STAGES_CSV` from `STAGES`.

**Build mode resolution** (strategy-aware, deterministic precedence):
1. `--build-mode <mode>` from orchestrator args (highest priority)
2. `ship.metal.build_mode` from feature config (when strategy is bare_metal)
3. Strategy default:
   - `bare_metal` → `sync_only`
   - `k8s` → `docker`

```bash
CONFIG_BUILD_MODE=$(echo "$INIT" | jq -r '.ship.metal.build_mode // empty')
BUILD_MODE_OVERRIDE=""   # parsed from --build-mode

if [ -n "$BUILD_MODE_OVERRIDE" ]; then
  BUILD_MODE="$BUILD_MODE_OVERRIDE"
elif [ -n "$CONFIG_BUILD_MODE" ]; then
  BUILD_MODE="$CONFIG_BUILD_MODE"
elif [ "$SHIP_STRATEGY" = "bare_metal" ]; then
  BUILD_MODE="sync_only"
else
  BUILD_MODE="docker"
fi
```

```bash
MAX_LOOPS=$(echo "$INIT" | jq -r '.tuning.max_optimization_loops // 3')
```

**Checkpoint resume**: Load STATE.md for feature. If `completed_stages` is non-empty and
`pipeline_stages` matches current `STAGES`:
- Ask user: "Previous pipeline was interrupted after [completed]. Resume from [next]? Or restart?"
- If resume: set STAGES to remaining uncompleted stages
- If restart:
  ```bash
  node "$DEVTEAM_BIN" pipeline reset --feature "$FEATURE"
  node "$DEVTEAM_BIN" run reset --feature "$FEATURE"
  ```

Resume continuity rule:
- Treat `tasks.json` as the source of truth for remaining work; `plan.md` checkboxes are a view only.

**Run snapshot + dirty-worktree gate** (must happen before any stage execution):
```bash
RUN_INIT=$(node "$DEVTEAM_BIN" run init --feature "$FEATURE" --stages "$STAGES_CSV")
RUN_PATH=$(echo "$RUN_INIT" | jq -r '.run_path')
RUN_ID=$(echo "$RUN_INIT" | jq -r '.run.run_id')
```

If `RUN_INIT.requires_dirty_decision == true`:
1. Surface dirty repos from `RUN_INIT.dirty_repos`.
2. Ask user whether to continue or abort.
3. If continue:
   ```bash
   RUN_INIT=$(node "$DEVTEAM_BIN" run init --feature "$FEATURE" --stages "$STAGES_CSV" --restart --dirty-decision continue)
   RUN_PATH=$(echo "$RUN_INIT" | jq -r '.run_path')
   RUN_ID=$(echo "$RUN_INIT" | jq -r '.run.run_id')
   ```
4. If abort:
   ```bash
   node "$DEVTEAM_BIN" run init --feature "$FEATURE" --stages "$STAGES_CSV" --restart --dirty-decision abort
   ```
   Stop orchestration without starting pipeline stages.

If `RUN_INIT.requires_execution_identity_fix == true`:
1. Surface `RUN_INIT.invalid_execution_repos` (repo + reasons) to user.
2. Hard stop orchestration.
3. Do NOT AskUserQuestion for continue/cancel; this is an environment identity error and must be fixed before retry.

Execution identity rule:
- Every stage that touches code, review scope, build provenance, or deployment inputs must rely on
  `$RUN_PATH` identity rather than re-deriving repo/worktree state from ambient files.
- Coder path writes are enforced via `run check-path` against RUN-frozen dev worktrees before edits/commits.

Gates:
- workspace.yaml must exist
- Feature must be listed in workspace.yaml defaults.features
- If "spec" in STAGES and spec.md exists, ask user whether to re-spec or skip
- `RUN.json` must exist before pipeline init (`$RUN_PATH`)
</step>

<step name="CREATE_TEAM">
Create the team and task list — only for selected stages.

1. `TeamCreate(team_name: "devteam-$FEATURE", description: "Pipeline for $FEATURE")`

2. Record pipeline stages in STATE.md (only after RUN snapshot is accepted):
```bash
node "$DEVTEAM_BIN" pipeline init --feature "$FEATURE" --stages "$STAGES_CSV"
```

If `pipeline init` fails with slot conflict:
1. Surface the conflicting feature/worktree from the CLI error.
2. AskUserQuestion with three options:
   - retry once with `--allow-slot-conflict`
   - wait for the conflicting pipeline to complete and retry
   - cancel this orchestration run
3. If user picks override, run:
   ```bash
   node "$DEVTEAM_BIN" pipeline init --feature "$FEATURE" --stages "$STAGES_CSV" --allow-slot-conflict
   ```

3. Create tasks dynamically — only for stages in STAGES:
```
prev_task = null
for stage in STAGES:
  T[stage] = TaskCreate(subject: "<stage description for $FEATURE>")
  if prev_task: TaskUpdate(T[stage], addBlockedBy: [prev_task])
  prev_task = T[stage]
```

Stage descriptions:
- spec: "Define requirements for $FEATURE"
- plan: "Create implementation plan"
- code: "Implement plan"
- review: "Review implementation"
- build: "Build Docker image"
- ship: "Deploy to cluster"
- verify: "Verify deployment"

Report to user:
```
devteam pipeline for: $FEATURE
Stages: $STAGES_CSV
Max optimization loops: $MAX_LOOPS
Run snapshot: $RUN_PATH ($RUN_ID)
```
</step>

<step name="STAGE_RESULT_PROTOCOL">
All stage agents must follow `skills/references/stage-result-contract.md`.

After every `Agent(...)` + wait cycle:
1. Capture the final agent message.
2. Resolve it through the high-level orchestration helper:
   ```bash
   printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
     --feature "$FEATURE" \
     --stage "<stage-name>" \
     [--report-path "$WORKSPACE/.dev/features/$FEATURE/<artifact>.md"] \
     [--summary "<checkpoint summary>"] \
     [--review-cycle "$review_cycle" --max-review-cycles "$max_review_cycles"]
   ```
3. Validate required keys:
   - `stage`
   - `status`
   - `verdict`
   - `artifacts`
   - `next_action`
   - `retryable`
   - `metrics`
4. Validate `stage` matches the current stage name exactly.
5. Use the helper output as the single source of truth for branching logic.
   Branch only on fixed `decision` payload fields:
   - `decision`
   - `reason`
   - `needs_user_input`
   - `retryable`
   - `next_action`
   - `user_prompt`
   - `loop_context`
   - `remediation_items`
   - `regressions`
   Do not branch on stage-specific prose in the raw agent report.
   Decision mapping:
   - `decision == accept` → the stage has already been accepted and checkpointed
   - `decision == review_fix_loop` → feed `remediation_items` back to coder
   - `decision == optimization_loop` → feed `regressions` to vLLM-Opter
   - `decision == retry` → offer retry before aborting
   - `decision == needs_input` → AskUserQuestion before proceeding using `user_prompt` (fallback to `next_action`)
   - For `stage == code`, remediation and retry paths must preserve coder's `run check-path` enforcement for all write targets.
6. If the JSON block is missing or malformed, send one corrective message to the same agent:
   "Resend your final message with a valid STAGE_RESULT JSON block and no prose after it."
7. If the agent still fails to comply, treat the stage as failed and AskUserQuestion for retry/abort guidance.

Checkpoint ownership:
- Agents do NOT update `feature_stage`, `completed_stages`, or workflow checkpoints.
- After a stage is accepted, the orchestration helper appends the stage to `completed_stages`,
  updates `feature_stage`, and writes the stage checkpoint summary.

Stage acceptance rules:
- `status == "completed"` and `verdict in [PASS, PASS_WITH_WARNINGS]` → stage accepted
- `status == "completed"` and `verdict == FAIL` → stage logic completed but found blocking issues
- `status == "failed"` → execution failure, retry/escalate path
- `status == "needs_input"` or `verdict == NEEDS_INPUT` → AskUserQuestion before proceeding
</step>

<step name="RUN_SPEC">
**Guard: skip if "spec" not in STAGES.**

1. Use AskUserQuestion to collect requirements (5 questions: goal, scope, constraints, verification, out-of-scope)
2. Compile into requirements brief
3. Spawn:
```
Agent(
  name: "spec-agent",
  subagent_type: "devteam:spec",
  team_name: "devteam-$FEATURE",
  prompt: "Generate spec.md for feature '$FEATURE' in workspace $WORKSPACE.
    User requirements: $REQUIREMENTS_BRIEF
    Your task ID: $T_SPEC_ID"
)
```
4. Wait for completion, then resolve the stage:
   ```bash
   printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
     --feature "$FEATURE" \
     --stage spec \
     --summary "Spec complete for $FEATURE"
   ```
5. Require `decision == accept`.
6. Verify `spec.md` exists and the acceptance payload references stage `spec`.
</step>

<step name="RUN_PLAN">
**Guard: skip if "plan" not in STAGES.**

```
Agent(
  name: "planner",
  subagent_type: "devteam:planner",
  team_name: "devteam-$FEATURE",
  prompt: "Create implementation plan for feature '$FEATURE' in workspace $WORKSPACE.
    Spec: $WORKSPACE/.dev/features/$FEATURE/spec.md
    Run snapshot: $RUN_PATH
    [OPTIMIZATION_CONTEXT if present]
    Your task ID: $T_PLAN_ID"
)
```

Wait for completion, then resolve the stage:
```bash
printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
  --feature "$FEATURE" \
  --stage plan \
  --summary "Plan complete for $FEATURE"
```

Require:
- `decision == accept`
- metrics include `task_count`, `wave_count`, and `build_mode`
- artifacts include both `plan.md` and `tasks.json`

Verify `plan.md` exists.
Verify `.dev/features/$FEATURE/tasks.json` exists.
</step>

<step name="RUN_CODE">
**Guard: skip if "code" not in STAGES.**

```
Agent(
  name: "coder",
  subagent_type: "devteam:coder",
  team_name: "devteam-$FEATURE",
  prompt: "Implement the plan for feature '$FEATURE' in workspace $WORKSPACE.
    Plan: $WORKSPACE/.dev/features/$FEATURE/plan.md
    Run snapshot: $RUN_PATH
    [FIX_CONTEXT if reviewer sent fix instructions]
    Your task ID: $T_CODE_ID"
)
```

Wait for completion, then resolve the stage:
```bash
printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
  --feature "$FEATURE" \
  --stage code \
  --summary "Code complete for $FEATURE"
```

Branch on resolved decision:
- `accept`:
  capture commit artifacts for the user-facing summary
  require at least one `commit` artifact unless the plan explicitly contained zero executable tasks
- `retry`:
  AskUserQuestion for retry / abort
- `needs_input`:
  AskUserQuestion with the agent's blocking reason or remediation items
</step>

<step name="RUN_REVIEW">
**Guard: skip if "review" not in STAGES.**

Max 2 review cycles.
```
review_cycle = 0
max_review_cycles = 2
```

Loop:
```
Agent(
  name: "reviewer",
  subagent_type: "devteam:reviewer",
  team_name: "devteam-$FEATURE",
  prompt: "Review implementation for feature '$FEATURE' in workspace $WORKSPACE.
    Spec: $WORKSPACE/.dev/features/$FEATURE/spec.md
    Plan: $WORKSPACE/.dev/features/$FEATURE/plan.md
    Review baseline must come from RUN snapshot start heads in $RUN_PATH.
    Your task ID: $T_REVIEW_ID"
)
```

Resolve the stage:
```bash
printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
  --feature "$FEATURE" \
  --stage review \
  --report-path "$WORKSPACE/.dev/features/$FEATURE/review.md" \
  --review-cycle "$review_cycle" \
  --max-review-cycles "$max_review_cycles"
```

Require review metrics to include `finding_counts`.

Branch on resolved decision:
- `accept`: proceed
- `review_fix_loop`:
  1. Extract `remediation_items`
  2. Re-spawn coder with FIX_CONTEXT from `remediation_items`, then re-spawn reviewer, review_cycle++
- `retry`:
  AskUserQuestion for retry / abort
- `needs_input`:
  AskUserQuestion for guidance
</step>

<step name="RUN_BUILD">
**Guard: skip if "build" not in STAGES.**

**Bare metal build mode guard**:
Build stage behavior is selected by effective `$BUILD_MODE`:
- `skip` → skip build stage entirely (resolve stage as accepted with summary: skipped by build mode)
- `sync_only` → builder runs sync.sh only (no Docker build)
- `source_install` → builder runs sync.sh + setup/install script
- `docker` → normal Docker build path

When `$SHIP_STRATEGY == "bare_metal"` and `$BUILD_MODE == "skip"`, do not spawn builder;
resolve the stage immediately with a skipped summary and continue to ship.

```
Agent(
  name: "builder",
  subagent_type: "devteam:builder",
  team_name: "devteam-$FEATURE",
  prompt: "Run build stage for feature '$FEATURE' in workspace $WORKSPACE.
    Run snapshot: $RUN_PATH
    Ship strategy: $SHIP_STRATEGY
    Build mode: $BUILD_MODE
    Your task ID: $T_BUILD_ID"
)
```

Wait for completion, then resolve the stage:
```bash
printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
  --feature "$FEATURE" \
  --stage build \
  --summary "Build complete for $FEATURE"
```

Require:
- For k8s: image artifact with `tag` + build-manifest artifact path
- For bare_metal: sync confirmation artifact (build-manifest optional)

Branch on resolved decision:
- `accept`:
  For k8s: extract `$NEW_TAG` from the image artifact
  For bare_metal: note sync/install completion
- `retry`:
  AskUserQuestion for retry / abort
- `needs_input`:
  AskUserQuestion for next step
</step>

<step name="RUN_SHIP">
**Guard: skip if "ship" not in STAGES.**

**Strategy-aware behavior**:
- k8s: check cluster safety, then spawn shipper for kubectl deploy
- bare_metal: shipper uses SSH to stop → sync → start → health check (no kubectl)

1. Check cluster safety from `$INIT` (k8s only, skip for bare_metal):
   - `safety: prod` → AskUserQuestion to confirm before spawning shipper
   - User declines → abort gracefully

2. Spawn:
```
Agent(
  name: "shipper",
  subagent_type: "devteam:shipper",
  team_name: "devteam-$FEATURE",
  prompt: "Deploy image '$NEW_TAG' for feature '$FEATURE' to cluster.
    Workspace: $WORKSPACE
    Run snapshot: $RUN_PATH
    [CONFIRMED: user approved deployment]
    Your task ID: $T_SHIP_ID"
)
```

Wait for completion, then resolve the stage:
```bash
printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
  --feature "$FEATURE" \
  --stage ship \
  --summary "Ship complete for $FEATURE"
```

Require ship metrics to include readiness and health-check outcome before considering the stage accepted.

Branch on resolved decision:
- `accept`: proceed
- `retry`: AskUserQuestion (retry / abort)
- `needs_input`: AskUserQuestion for next step
</step>

<step name="RUN_VERIFY">
**Guard: skip if "verify" not in STAGES.**

```
Agent(
  name: "verifier",
  subagent_type: "devteam:verifier",
  team_name: "devteam-$FEATURE",
  prompt: "Verify deployment for feature '$FEATURE'. Run smoke checks and benchmarks.
    Workspace: $WORKSPACE
    Run snapshot: $RUN_PATH
    Your task ID: $T_VERIFY_ID"
)
```

Resolve the stage:
```bash
printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
  --feature "$FEATURE" \
  --stage verify \
  --report-path "$WORKSPACE/.dev/features/$FEATURE/verify.md"
```

Require metrics include smoke counts and regression threshold.

Branch on resolved decision:
- `accept` → go to CLEANUP
- `optimization_loop`:
  capture `VERIFIER_METRICS` from the resolved payload, then go to OPTIMIZATION_LOOP
- `retry`:
  AskUserQuestion (retry / abort)
- `needs_input`:
  AskUserQuestion for next step
</step>

<step name="OPTIMIZATION_LOOP">
Triggered when verifier reports FAIL. Only runs if "verify" is in STAGES.

```
loop_count = 0
```

While verifier FAIL and loop_count < MAX_LOOPS:

1. Checkpoint:
   ```bash
   node "$DEVTEAM_BIN" pipeline loop --feature "$FEATURE" --count "$loop_count"
   ```

2. Spawn vLLM-Opter:
```
Agent(
  name: "vllm-opter",
  subagent_type: "devteam:vllm-opter",
  team_name: "devteam-$FEATURE",
  prompt: "Analyze performance regression for '$FEATURE'.
    Regression report: <verifier_metrics>
    Workspace: $WORKSPACE
    Run snapshot: $RUN_PATH
    Your task ID: $OPT_TASK_ID"
)
```

3. Wait for optimization guidance, then resolve the stage:
   ```bash
   printf '%s' "$AGENT_MESSAGE" | node "$DEVTEAM_BIN" orchestration resolve-stage \
     --feature "$FEATURE" \
     --stage vllm-opt \
     --report-path "$WORKSPACE/.dev/features/$FEATURE/optimization-guidance.md"
   ```

4. Require `decision == accept` and guidance artifact path or guidance metrics sufficient for planner input.

5. Re-run sub-pipeline (only stages that make sense for optimization):
   - RUN_PLAN (with OPTIMIZATION_CONTEXT)
   - RUN_CODE
   - RUN_REVIEW
   - RUN_BUILD
   - RUN_SHIP
   - RUN_VERIFY

6. `loop_count++`

If exhausted:
```
AskUserQuestion:
  - "Continue with N more loops"
  - "Accept current performance"
  - "Abort pipeline"
```
</step>

<step name="CLEANUP">
Pipeline complete.

1. Update phase:
```bash
node "$DEVTEAM_BIN" pipeline complete --feature "$FEATURE" --stages "$ALL_COMPLETED_CSV" --summary "Pipeline complete for $FEATURE"
```

2. `TeamDelete`

3. Report summary:
```
Pipeline Complete: $FEATURE
  Stages: $STAGES_CSV
  Tasks completed: N
  [Image: $NEW_TAG]           # if build was in STAGES
  [Cluster: $CLUSTER/$NS]    # if ship was in STAGES
  [Verification: PASS]        # if verify was in STAGES
  Optimization loops: $loop_count
```
</step>

</process>

<anti_rationalization>

| Temptation | Reality |
|---|---|
| "Skip the spec, I know what to build" | Unstated assumptions cause 80% of rework |
| "The review is just formality" | AI code needs MORE scrutiny, not less |
| "Skip verification, tests passed locally" | Production has different data, traffic, edge cases |
| "One more optimization loop will fix it" | 3 loops is the safety valve. Ask the human. |
| "I'll deploy without GPU checks" | GPU env issues cause silent correctness bugs and OOMs |
| "Use general-purpose agent instead of native type" | Native subagent_type enforces tool restrictions. General-purpose has no guardrails. |
| "Run all stages even though user said --stages" | Respect the user's selection. They know their workflow. |

**Red Flags:**
- Running stages not in STAGES list
- Using `subagent_type: "general-purpose"` instead of `"devteam:XXX"`
- Skipping checkpoint writes between stages
- Ignoring reviewer FAIL verdict
- Optimization loop exceeding max without user consent
- kubectl commands missing `-n <namespace>`

</anti_rationalization>
