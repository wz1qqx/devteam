# Skill: orchestrator (TEAM)

<purpose>
Automated multi-agent pipeline orchestration. One command starts the full lifecycle:
Spec → Plan → Code → Review → Build → Ship → Verify, with optimization feedback loops.
Uses Claude Code native TeamCreate + Agent + TaskCreate + SendMessage mechanisms.
</purpose>

<core_principle>
The orchestrator is a coordinator, not an implementer. It creates the team, spawns agents
sequentially based on dependency gates, handles feedback loops (reviewer FAIL → coder fix,
verifier FAIL → vllm-opter → planner re-plan), and cleans up when done.
</core_principle>

<process>

<step name="INIT" priority="first">
Initialize workflow context and parse arguments.

```bash
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init team)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
```

Parse from $ARGUMENTS:
- **FEATURE**: first positional arg (required)
- **--max-loops N**: max optimization iterations (default: `tuning.max_optimization_loops`, typically 3)
- **--skip-spec**: skip spec phase if spec.md already exists

```bash
FEATURE="$1"
MAX_LOOPS=$(echo "$INIT" | jq -r '.tuning.max_optimization_loops // 3')
```

Gates:
- .dev.yaml must exist
- Feature must be defined in .dev.yaml
- If not --skip-spec and spec.md exists, ask user whether to re-spec or skip
</step>

<step name="CREATE_TEAM">
Create the team and task list.

1. `TeamCreate(team_name: "devteam-$FEATURE", description: "Automated pipeline for $FEATURE")`

2. Create tasks with dependency chain:

```
If spec needed:
  T1 = TaskCreate(subject: "Define requirements for $FEATURE")

T2 = TaskCreate(subject: "Create implementation plan")
  → TaskUpdate(addBlockedBy: [T1]) if T1 exists

T3 = TaskCreate(subject: "Implement plan")
  → TaskUpdate(addBlockedBy: [T2])

T4 = TaskCreate(subject: "Review implementation")
  → TaskUpdate(addBlockedBy: [T3])

T5 = TaskCreate(subject: "Build Docker image")
  → TaskUpdate(addBlockedBy: [T4])

T6 = TaskCreate(subject: "Deploy to cluster")
  → TaskUpdate(addBlockedBy: [T5])

T7 = TaskCreate(subject: "Verify deployment")
  → TaskUpdate(addBlockedBy: [T6])
```

Report to user:
```
devteam pipeline started for: $FEATURE
Tasks: 7 (or 6 if --skip-spec)
Max optimization loops: $MAX_LOOPS
```
</step>

<step name="RUN_SPEC">
If spec phase needed (T1 exists):

1. Spawn spec agent:
```
Agent(
  name: "spec",
  prompt: "You are the spec agent for feature '$FEATURE'. Load your role from agents/spec.md. Discuss requirements with the user and generate spec.md. Your task ID: $T1_ID",
  team_name: "devteam-$FEATURE"
)
```

2. Wait for spec agent message (it sends completion notice via SendMessage)
3. Verify `.dev/features/$FEATURE/spec.md` exists
4. If file missing, report error and abort
</step>

<step name="RUN_PLAN">
Plan phase (T2).

Build prompt context:
- Base: spec path `.dev/features/$FEATURE/spec.md`
- If this is an optimization re-plan: append vLLM-Opter's guidance

```
Agent(
  name: "planner",
  prompt: "Create implementation plan for feature '$FEATURE'.
    Spec: .dev/features/$FEATURE/spec.md
    [OPTIMIZATION_CONTEXT if present]
    Your task ID: $T2_ID",
  team_name: "devteam-$FEATURE"
)
```

Wait for completion. Verify `plan.md` exists.
</step>

<step name="RUN_CODE">
Code phase (T3).

```
Agent(
  name: "coder",
  prompt: "Implement the plan for feature '$FEATURE'.
    Plan: .dev/features/$FEATURE/plan.md
    [FIX_CONTEXT if reviewer sent fix instructions]
    Your task ID: $T3_ID",
  team_name: "devteam-$FEATURE"
)
```

Wait for completion.
</step>

<step name="RUN_REVIEW">
Review phase (T4). Max 2 review cycles.

```
review_cycle = 0
max_review_cycles = 2
```

Loop:
```
Agent(
  name: "reviewer",
  prompt: "Review implementation for feature '$FEATURE'. Your task ID: $T4_ID",
  team_name: "devteam-$FEATURE"
)
```

Wait for verdict message. Parse verdict:
- **PASS** or **PASS_WITH_WARNINGS** → proceed to BUILD
- **FAIL** →
  1. Extract remediation items from reviewer's message
  2. If review_cycle < max_review_cycles:
     - Create new fix task
     - Re-spawn coder with fix instructions as context
     - Re-spawn reviewer
     - review_cycle++
  3. Else: report to user, ask for guidance via AskUserQuestion
</step>

<step name="RUN_BUILD">
Build phase (T5).

```
Agent(
  name: "builder",
  prompt: "Build Docker image for feature '$FEATURE'. Your task ID: $T5_ID",
  team_name: "devteam-$FEATURE"
)
```

Wait for completion. Extract new image tag from builder's message.
Store as `$NEW_TAG`.
</step>

<step name="RUN_SHIP">
Deploy phase (T6).

```
Agent(
  name: "shipper",
  prompt: "Deploy image '$NEW_TAG' for feature '$FEATURE' to the active cluster. Your task ID: $T6_ID",
  team_name: "devteam-$FEATURE"
)
```

Wait for deployment confirmation.
</step>

<step name="RUN_VERIFY">
Verify phase (T7).

```
Agent(
  name: "verifier",
  prompt: "Verify deployment for feature '$FEATURE'. Run smoke checks and benchmarks. Your task ID: $T7_ID",
  team_name: "devteam-$FEATURE"
)
```

Wait for verdict:
- **PASS** → pipeline complete, go to CLEANUP
- **FAIL** → go to OPTIMIZATION_LOOP
</step>

<step name="OPTIMIZATION_LOOP">
Triggered when verifier reports FAIL (performance regression).

```
loop_count = 0
```

While verifier FAIL and loop_count < MAX_LOOPS:

1. **Spawn vLLM-Opter**:
```
Agent(
  name: "vllm-opter",
  prompt: "Analyze performance regression for '$FEATURE'.
    Regression report: <verifier_metrics_from_message>
    Your task ID: $OPT_TASK_ID",
  team_name: "devteam-$FEATURE"
)
```

2. Wait for optimization guidance

3. **Re-run pipeline with optimization context**:
   - RUN_PLAN with optimization guidance as OPTIMIZATION_CONTEXT
   - RUN_CODE
   - RUN_REVIEW
   - RUN_BUILD
   - RUN_SHIP
   - RUN_VERIFY

4. `loop_count++`

If loop_count >= MAX_LOOPS and still FAIL:
```
Report to user:
  "Optimization loop exhausted after $MAX_LOOPS iterations.
   Latest metrics: <metrics>.
   Please review and provide guidance."

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
node "$DEVFLOW_BIN" state update phase completed
```

2. Checkpoint:
```bash
node "$DEVFLOW_BIN" checkpoint --action "team-complete" --summary "Pipeline complete for $FEATURE"
```

3. `TeamDelete` — clean up team resources

4. Report final summary:
```
Pipeline Complete: $FEATURE
  Tasks completed: N
  Image: $NEW_TAG
  Cluster: $CLUSTER/$NAMESPACE
  Verification: PASS
  Optimization loops: $loop_count
  Duration: ~Xm
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

**Red Flags:**
- Skipping any pipeline phase
- Deploying without verification
- Ignoring reviewer FAIL verdict
- Optimization loop exceeding max without user consent
- kubectl commands missing `-n <namespace>`

</anti_rationalization>
