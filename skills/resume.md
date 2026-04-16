# Skill: resume

<purpose>Restore session state from feature-scoped HANDOFF.json, STATE.md, and context.md. Zero context loss across sessions -- load everything needed to continue exactly where the user left off.</purpose>
<core_principle>The resumed session must have the same effective context as the paused session. HANDOFF.json gives precise position; STATE.md gives workflow position; feature context.md gives decisions and blockers. Feature artifacts provide domain context. The user should never need to re-explain.</core_principle>

Runtime artifact precedence during resume:
1. `tasks.json` determines remaining/next executable tasks.
2. `RUN.json` determines frozen repo/worktree/SHA execution identity.
3. `plan.md` is a rendered summary for humans and must not override task state.

<process>
<step name="INIT" priority="first">
Load project configuration and locate handoff artifacts.

```bash
# Auto-discover devteam CLI (marketplace or local install)
DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVTEAM_BIN" init resume)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
FEATURE=$(echo "$INIT" | jq -r '.feature.name')
PHASE=$(echo "$INIT" | jq -r '.feature.phase')
CURRENT_TAG=$(echo "$INIT" | jq -r '.feature.current_tag')
```

Gate: `workspace.yaml` must exist. If not: "No project found. Run `/devteam init` first."
</step>

<step name="LOAD_HANDOFF">
Parse the feature-scoped HANDOFF.json for precise session position.

```bash
HANDOFF_PATH="$WORKSPACE/.dev/features/$FEATURE/HANDOFF.json"
```

If HANDOFF.json exists:
- Parse all fields: feature, feature_stage, task_progress, completed_tasks, remaining_tasks, decisions_this_session, uncommitted_files, next_action, context_notes, paused_at, ttl_days

- **Staleness check**:
  ```
  age_days = (now - paused_at).days
  ttl = ttl_days ?? 7
  if age_days > ttl:
    display "⚠ Stale context: HANDOFF is {age_days} days old (TTL: {ttl}d)"
    display "  Decisions and context from that session may no longer apply."
    display "  Review carefully before acting on restored next_action."
  ```

- Display restoration summary:
  ```
  Restoring from HANDOFF.json (paused: <paused_at>, {age_days}d ago)
    Feature: <feature> (stage: <stage>)
    Progress: <current>/<total> tasks
    Next action: <next_action>
    Context: <context_notes>
  ```
- Delete HANDOFF.json after successful load (consumed):
  ```bash
  rm "$WORKSPACE/.dev/features/$FEATURE/HANDOFF.json"
  ```

If no HANDOFF.json: note "No feature-scoped HANDOFF found. Resuming from STATE.md and feature context."
</step>

<step name="LOAD_STATE">
Load STATE.md for workflow position and recent activity.

```bash
STATE_PATH="$WORKSPACE/.dev/features/$FEATURE/STATE.md"
```

If STATE.md exists:
- Parse frontmatter only: project, phase, feature_stage, plan_progress, last_activity
- Read `## Position` section for current activity summary and next step
- Do NOT load Decisions or Blockers from STATE.md — these are feature-scoped and loaded in LOAD_FEATURE_CONTEXT

If no STATE.md: "No STATE.md found. Will be created on next workflow action."
</step>

<step name="LOAD_FEATURE_CONTEXT">
Load feature-specific artifacts for domain context.

```bash
FEATURE_DIR="$WORKSPACE/.dev/features/$FEATURE"
```

**Decisions and Blockers** (from feature-scoped context.md):
```bash
CONTEXT_PATH="$WORKSPACE/.dev/features/$FEATURE/context.md"
```
If context.md exists:
- Parse `## Decisions` table — display all rows
- Parse `## Active Blockers` table — display all rows
- Display:
  ```
  Decisions ($FEATURE):
    D-01: <decision> (<date>)
    D-02: ...
  Active Blockers ($FEATURE):
    B-01: <blocker> [<type>] - workaround: <workaround>
  ```
If context.md missing: "No feature context found. Will be created on first pause."

**Feature artifacts** (load if available):
- `features/$FEATURE/tasks.json` -- authoritative machine task state
- `features/$FEATURE/plan.md` -- human-readable rendered plan
- `features/$FEATURE/spec.md` -- feature specification
- `features/$FEATURE/review.md` -- code review results
- `features/$FEATURE/verify.md` -- verification and benchmark summary
- `features/$FEATURE/optimization-guidance.md` -- optimization guidance from vLLM-Opter

Task summary source:
```bash
TASK_SUMMARY=$(node "$DEVTEAM_BIN" tasks summary --feature "$FEATURE")
DONE=$(echo "$TASK_SUMMARY" | jq -r '.summary.completed_tasks')
TOTAL=$(echo "$TASK_SUMMARY" | jq -r '.summary.total_tasks')
```

Run snapshot source:
```bash
RUN_STATE=$(node "$DEVTEAM_BIN" run get --feature "$FEATURE")
RUN_PATH=$(echo "$RUN_STATE" | jq -r '.run_path')
RUN_ID=$(echo "$RUN_STATE" | jq -r '.run.run_id // empty')
```

Display feature artifact status:
```
Feature: $FEATURE
  Spec:    [exists/missing]
  Tasks:   [exists/missing] (<done>/<total> tasks)
  Run:     [exists/missing] (run_id: <run-id>)
  Context: [exists/missing] (<N> decisions, <M> active blockers)
  Plan:    [exists/missing]
  Review:  [exists/missing] (verdict: <verdict>)
  Verify:  [exists/missing] (smoke + benchmark summary)
  Opt:     [exists/missing] (latest optimization guidance)
```

**Wiki context** (explicit selection — do NOT auto-load):
```bash
WIKI_DIR=$(echo "$INIT" | jq -r '.wiki_dir // empty')
```
If wiki exists and pages match feature topic:
```
Wiki pages available for "$FEATURE":
  [1] <page-title> (updated: <date>)
  [2] <page-title> (updated: <date>)
Load which pages? (e.g. "1 2", "all", or "none" to skip)
```
Wait for user input. Load only selected pages.
If no matching pages or wiki not configured: skip silently.

**Check uncommitted files** across all dev worktrees (from `$INIT.repos`, which is RUN-frozen when `RUN.json` exists):
```bash
echo "$INIT" | jq -r '.repos | to_entries[] | .value.dev_worktree // empty' | \
  while read DEV_WT; do
    STATUS=$(git -C "$DEV_WT" status --porcelain 2>/dev/null)
    [ -n "$STATUS" ] && echo "Uncommitted in $DEV_WT:" && echo "$STATUS"
  done
```
</step>

<step name="SHOW_STATUS">
Display layered project status dashboard.

```
=== Active Context ===

Feature: $FEATURE (stage: $FEATURE_STAGE)
  Progress: $DONE/$TOTAL tasks
  Next action: <next_action from HANDOFF, or phase-based suggestion>
  [⚠ Stale: {age_days}d old — context may not apply]   ← only shown when stale

  Decisions ($FEATURE):
    D-01: <decision> (<date>)
    ...
  Active Blockers:
    B-01: <blocker> [<type>] - workaround: <workaround>
    (none)

  Uncommitted files: <N files / none>

=== Project State ===

Project: $PROJECT  |  Phase: $PHASE
Last activity: $LAST_ACTIVITY
Tag: $CURRENT_TAG

Repos:
  <repo>: <worktree> (<base_ref> + N commits) [uncommitted: Y/N]

Cluster: $CLUSTER ($NAMESPACE)
  Deploy: <current deployment status if available>
```

Notes:
- "Active Context" shows only current feature's information
- "Project State" shows global project status (phase, cluster, build)
- Stale warning appears only when HANDOFF age > ttl_days
- If no HANDOFF was loaded, omit "Next action" line; rely on SUGGEST_NEXT
</step>

<step name="SUGGEST_NEXT">
Suggest next action based on restored state.

**If HANDOFF was restored**: use `next_action` as primary suggestion:
```
Suggested next step: <next_action from HANDOFF>
  Command: <specific devteam command to run>
```

**Otherwise**, suggest based on current phase:

| Phase | Suggestion |
|---|---|
| `init` | "Project initialized. Start with: `/devteam team $FEATURE`" |
| `dev` | "Continue development. Build when ready: `/devteam team $FEATURE`" |
| `build` | "Build complete ($CURRENT_TAG). Deploy: `/devteam team $FEATURE`" |
| `deploy` | "Deployed. Verify: `/devteam team $FEATURE`" |
| `verify` | "Verified. Start next feature or observe." |
| `debug` | "Debug session active. Resume investigation." |

**Check for in-progress work**:
- `tasks.json` with pending/in_progress tasks: "Resume execution: `/devteam team $FEATURE`"
- Review with FAIL verdict: "Fix review issues: `/devteam team $FEATURE`"
- Uncommitted files: "Warning: N uncommitted files. Commit or stash before proceeding."

**Check active blockers**: if unresolved blockers exist, warn:
```
Active blockers may affect next steps:
  B-01: <blocker> -- workaround: <workaround>
```
</step>
</process>

<anti_rationalization>

## Anti-Rationalization Table

| Temptation | Reality Check |
|---|---|
| "I remember the context" | This is a new session. You have zero prior context. Load everything. |
| "HANDOFF is enough" | HANDOFF is position. Feature STATE.md is history. Feature artifacts are domain knowledge. Load all three. |
| "I'll figure out what to do" | The paused session already determined next_action. Follow it. |
| "Uncommitted files are fine" | They might be intentional WIP or forgotten changes. Surface them explicitly. |
| "Wiki context is optional" | Domain knowledge prevents re-derivation. Load it. |
| "I'll skip the status dashboard" | The user needs orientation. Show the full picture before suggesting actions. |

## Red Flags

- Resuming without loading HANDOFF.json (if it exists)
- Not running staleness check on HANDOFF (user acts on expired context without warning)
- Not deleting HANDOFF.json after consumption (stale state in next pause)
- Loading Decisions/Blockers from STATE.md instead of feature context.md (cross-feature pollution)
- Auto-loading wiki pages without showing candidate list (forces irrelevant context)
- Ignoring uncommitted files warning
- Suggesting actions that conflict with active blockers
- Not showing feature artifact status (user can't assess completeness)

## Verification Checklist

- [ ] HANDOFF.json loaded and deleted (if existed)
- [ ] Staleness check run — stale warning shown if age > ttl_days
- [ ] STATE.md frontmatter + Position parsed (NOT Decisions/Blockers)
- [ ] context.md loaded for current feature (decisions + active blockers)
- [ ] Feature artifacts status shown (spec, context, plan, review)
- [ ] Wiki candidates listed, loaded only if user selects
- [ ] Uncommitted files surfaced
- [ ] Status displayed in two layers: Active Context + Project State
- [ ] Next action suggested (from HANDOFF or phase-based)
- [ ] Active blockers warned about

</anti_rationalization>
